import { existsSync } from 'fs'
import { join } from 'path'
import { Worker } from 'worker_threads'
import type { BinaryNode } from './types'
import type { BinaryCodecFailure, BinaryCodecResponse, BinaryCodecTask, BinaryCodecTaskInput } from './worker-types'

const DEFAULT_POOL_SIZE = 1
const WORKER_POOL_SIZE_ENV = 'BINARY_CODEC_WORKER_POOL_SIZE'

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
	return workers
}

const getNextWorker = () => {
	const currentWorkers = ensureWorkerPool()
	if (!currentWorkers || !currentWorkers.length) {
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
	const task: BinaryCodecTask = {
		...taskInput,
		id
	}

	return new Promise<T>((resolve, reject) => {
		pending.set(id, { resolve: resolve as (value: unknown) => void, reject })

		try {
			currentWorker.postMessage(task)
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
	} catch {
		return fallback()
	}
}

export const encodeBinaryNodeInWorker = (node: BinaryNode) => {
	return runTaskInWorker<Buffer>({ type: 'encode', node })
}

export const decodeBinaryNodeInWorker = (buffer: Buffer) => {
	return runTaskInWorker<BinaryNode>({ type: 'decode', buffer })
}
