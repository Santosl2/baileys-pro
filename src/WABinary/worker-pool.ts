import { existsSync } from 'fs'
import { join } from 'path'
import { Worker } from 'worker_threads'
import type { BinaryNode } from './types'
import type { BinaryCodecFailure, BinaryCodecResponse, BinaryCodecTask, BinaryCodecTaskInput } from './worker-types'

const DEFAULT_POOL_SIZE = 1
const WORKER_POOL_SIZE_ENV = 'BINARY_CODEC_WORKER_POOL_SIZE'
const DEBUG = process.env.BINARY_CODEC_WORKER_DEBUG === '1'

const dbg = (...args: unknown[]) => {
	if (DEBUG) {
		console.log('[WABinary:pool]', ...args)
	}
}

let workers: Worker[] = []
let workerPoolUnavailable = false
let taskCounter = 0
let nextWorkerIndex = 0

const pending = new Map<
	number,
	{
		resolve: (value: unknown) => void
		reject: (reason?: unknown) => void
	}
>()

const rejectPending = (reason: Error) => {
	for (const [, task] of pending) {
		task.reject(reason)
	}

	pending.clear()
}

const getConfiguredWorkerPoolSize = () => {
	const rawValue = process.env[WORKER_POOL_SIZE_ENV]
	const parsed = Number.parseInt(rawValue || '', 10)
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return DEFAULT_POOL_SIZE
	}

	return parsed
}

/**
 * Always copies the buffer data into a new ArrayBuffer for transfer.
 * This ensures the original Buffer stays intact (not detached)
 * so it can still be used in fallback closures if the worker fails.
 */
const bufferToTransferable = (buffer: Buffer): any => {
	if (buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength) {
		// no extra bytes, return the ArrayBuffer
		return buffer.buffer
	}

	return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
}

const makeWorkerError = (error: BinaryCodecFailure['error']) => {
	const err = new Error(error.message)
	err.stack = error.stack || err.stack
	return err
}

const getWorkerPath = () => {
	const jsPath = join(__dirname, 'worker.js')
	if (existsSync(jsPath)) {
		return jsPath
	}

	return join(__dirname, 'worker.ts')
}

const onWorkerMessage = (message: BinaryCodecResponse) => {
	const task = pending.get(message.id)
	if (!task) {
		return
	}

	pending.delete(message.id)

	if ('error' in message) {
		task.reject(makeWorkerError(message.error))
		return
	}

	if (message.type === 'encode' || message.type === 'decompress') {
		task.resolve(Buffer.from(message.result))
		return
	}

	function convertUint8ArrayToBufferInPlace(obj) {
		if (Array.isArray(obj)) {
			for (let i = 0; i < obj.length; i++) {
				if (obj[i] instanceof Uint8Array) {
					obj[i] = Buffer.from(obj[i])
				} else if (obj[i] !== null && typeof obj[i] === 'object') {
					convertUint8ArrayToBufferInPlace(obj[i])
				}
			}
		} else if (obj !== null && typeof obj === 'object') {
			for (const key of Object.keys(obj)) {
				if (obj[key] instanceof Uint8Array) {
					obj[key] = Buffer.from(obj[key])
				} else if (obj[key] !== null && typeof obj[key] === 'object') {
					convertUint8ArrayToBufferInPlace(obj[key])
				}
			}
		}
	}

	convertUint8ArrayToBufferInPlace(message.result)

	task.resolve(message.result)
}

const terminateAllWorkers = () => {
	for (const item of workers) {
		item.terminate().catch(() => undefined)
	}

	workers = []
	nextWorkerIndex = 0
}

const disableWorkerPool = (reason: Error) => {
	if (workerPoolUnavailable) {
		return
	}

	workerPoolUnavailable = true
	rejectPending(reason)
	terminateAllWorkers()
}

const ensureWorkerPool = () => {
	if (workerPoolUnavailable) {
		return null
	}

	if (workers.length) {
		return workers
	}

	const poolSize = getConfiguredWorkerPoolSize()
	const nextWorkers: Worker[] = []

	try {
		for (let i = 0; i < poolSize; i++) {
			const item = new Worker(getWorkerPath())
			item.on('message', onWorkerMessage)
			item.on('error', err => {
				disableWorkerPool(err)
			})
			item.on('exit', code => {
				if (!workerPoolUnavailable && code !== 0) {
					disableWorkerPool(new Error(`WABinary worker exited with code ${code}`))
				}
			})
			dbg(`worker[${i}] iniciado, threadId=${item.threadId}`)
			nextWorkers.push(item)
		}
	} catch (error) {
		const workerError = error instanceof Error ? error : new Error(String(error))
		disableWorkerPool(workerError)
		for (const item of nextWorkers) {
			item.terminate().catch(() => undefined)
		}

		return null
	}

	workers = nextWorkers
	nextWorkerIndex = 0
	dbg(`pool iniciado com ${workers.length} worker(s)`)
	return workers
}

const getNextWorker = () => {
	const currentWorkers = ensureWorkerPool()
	if (!currentWorkers?.length) {
		return null
	}

	const index = nextWorkerIndex % currentWorkers.length
	nextWorkerIndex += 1

	return currentWorkers[index]
}

const runTaskInWorker = <T>(taskInput: BinaryCodecTaskInput): Promise<T> => {
	const currentWorker = getNextWorker()
	if (!currentWorker) {
		return Promise.reject(new Error('WABinary worker unavailable'))
	}

	const id = ++taskCounter

	let task: BinaryCodecTask
	const transferList: ArrayBuffer[] = []

	if (taskInput.type === 'encode') {
		task = {
			...taskInput,
			id
		}
	} else {
		const ab = bufferToTransferable(taskInput.buffer)
		task = {
			id,
			type: taskInput.type,
			buffer: ab
		}
		transferList.push(ab)
	}

	return new Promise<T>((resolve, reject) => {
		pending.set(id, { resolve: resolve as (value: unknown) => void, reject })

		try {
			dbg(`task id=${id} type=${task.type} → worker threadId=${currentWorker.threadId}`)
			currentWorker.postMessage(task, transferList)
		} catch (error) {
			pending.delete(id)
			reject(error)
		}
	})
}

export const runBinaryCodecWorkerTask = async <T>(
	taskInput: BinaryCodecTaskInput,
	fallback: () => T | Promise<T>
): Promise<T> => {
	try {
		return await runTaskInWorker<T>(taskInput)
	} catch (err) {
		dbg(`fallback local para type=${taskInput.type}, motivo: ${(err as Error)?.message}`)
		return fallback()
	}
}

export const encodeBinaryNodeInWorker = (node: BinaryNode) => {
	return runTaskInWorker<Buffer>({ type: 'encode', node })
}

export const decodeBinaryNodeInWorker = (buffer: Buffer) => {
	return runTaskInWorker<BinaryNode>({ type: 'decode', buffer })
}
