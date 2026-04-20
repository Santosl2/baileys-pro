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

const toArrayBuffer = (value: ArrayBufferLike): ArrayBuffer => {
	if (value instanceof ArrayBuffer) {
		return value
	}

	const copy = new Uint8Array(value.byteLength)
	copy.set(new Uint8Array(value))
	return copy.buffer
}

const bufferToTransferable = (buf: Buffer): any => {
	if (buf.byteOffset === 0 && buf.buffer.byteLength === buf.byteLength) {
		return buf.buffer
	}

	return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
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

			const responseResult = bufferToTransferable(result)
			const response: BinaryCodecResponse = { id: task.id, type: 'encode', result: responseResult }
			port.postMessage(response, [responseResult])
			return
		}

		if (task.type === 'decompress') {
			const result = await decompressingIfRequiredLocal(Buffer.from(task.buffer))
			const responseResult = bufferToTransferable(result)
			const response: BinaryCodecResponse = { id: task.id, type: 'decompress', result: responseResult }
			port.postMessage(response, [responseResult])
			return
		}

		if (task.type === 'decode-decompressed') {
			const result = decodeDecompressedBinaryNodeLocal(Buffer.from(task.buffer), constants)
			const response: BinaryCodecResponse = { id: task.id, type: 'decode-decompressed', result }
			port.postMessage(response)
			return
		}

		const result = await decodeBinaryNodeLocal(Buffer.from(task.buffer))
		const response: BinaryCodecResponse = { id: task.id, type: 'decode', result }
		port.postMessage(response)
	} catch (error) {
		const response: BinaryCodecResponse = {
			id: task.id,
			error: toErrorObject(error)
		}
		port.postMessage(response)
	}
})
