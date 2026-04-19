import { parentPort, threadId } from 'worker_threads'
import * as constants from './constants'
import { decodeBinaryNodeLocal, decodeDecompressedBinaryNodeLocal, decompressingIfRequiredLocal } from './decode'
import { encodeBinaryNodeSync } from './encode'
import type { BinaryCodecResponse, BinaryCodecTask } from './worker-types'

if (!parentPort) {
	throw new Error('WABinary worker requires parent port')
}

const port = parentPort
const DEBUG = process.env.BINARY_CODEC_WORKER_DEBUG === '1'
const dbg = (...args: unknown[]) => {
	if (DEBUG) {
		console.log(`[WABinary:worker threadId=${threadId}]`, ...args)
	}
}

dbg('worker iniciado')

const toErrorObject = (error: unknown) => {
	if (error instanceof Error) {
		return {
			message: error.message,
			stack: error.stack
		}
	}

	return {
		message: String(error)
	}
}

port.on('message', async (task: BinaryCodecTask) => {
	dbg(`recebeu task id=${task.id} type=${task.type}`)
	try {
		if (task.type === 'encode') {
			const result = encodeBinaryNodeSync(task.node)
			const response: BinaryCodecResponse = {
				id: task.id,
				type: 'encode',
				result
			}
			port.postMessage(response)
			return
		}

		if (task.type === 'decompress') {
			const result = await decompressingIfRequiredLocal(task.buffer)
			const response: BinaryCodecResponse = {
				id: task.id,
				type: 'decompress',
				result
			}
			port.postMessage(response)
			return
		}

		if (task.type === 'decode-decompressed') {
			const result = decodeDecompressedBinaryNodeLocal(task.buffer, constants)
			const response: BinaryCodecResponse = {
				id: task.id,
				type: 'decode-decompressed',
				result
			}
			port.postMessage(response)
			return
		}

		const result = await decodeBinaryNodeLocal(task.buffer)
		const response: BinaryCodecResponse = {
			id: task.id,
			type: 'decode',
			result
		}
		port.postMessage(response)
	} catch (error) {
		const response: BinaryCodecResponse = {
			id: task.id,
			error: toErrorObject(error)
		}
		port.postMessage(response)
	}
})
