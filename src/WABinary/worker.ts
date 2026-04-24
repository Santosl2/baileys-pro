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

// Walks a BinaryNode recursively and collects every ArrayBuffer that backs a
// Buffer/Uint8Array field so they can be transferred (instead of cloned) in
// the postMessage call. After transfer the buffers are detached in this thread,
// but that is safe because the worker never touches the result again.
const collectTransferables = (obj: unknown, out: ArrayBuffer[]): void => {
	if (obj instanceof Uint8Array) {
		out.push(bufferToTransferable(obj as Buffer))
		return
	}

	if (Array.isArray(obj)) {
		for (const item of obj) {
			collectTransferables(item, out)
		}

		return
	}

	if (obj !== null && typeof obj === 'object') {
		for (const value of Object.values(obj)) {
			collectTransferables(value, out)
		}
	}
}

const bufferToTransferable = (buf: Buffer): any => {
	// Fast path: buffer owns its entire backing store — return as-is, zero-copy.
	if (buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength) {
		return buf.buffer
	}

	// Sub-view case (e.g. Node.js internal Buffer pool): the Buffer shares its
	// backing ArrayBuffer with other allocations, so we cannot transfer it as-is.
	// ArrayBuffer.slice() is the only standard way to produce an isolated,
	// transferable ArrayBuffer from a sub-range — the copy here is unavoidable.
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

			const transferables: ArrayBuffer[] = []
			collectTransferables(result, transferables)

			port.postMessage(response, transferables)
			return
		}

		const result = await decodeBinaryNodeLocal(Buffer.from(task.buffer))
		const response: BinaryCodecResponse = { id: task.id, type: 'decode', result }

		const transferables: ArrayBuffer[] = []
		collectTransferables(result, transferables)

		port.postMessage(response, transferables)
	} catch (error) {
		const response: BinaryCodecResponse = {
			id: task.id,
			error: toErrorObject(error)
		}
		port.postMessage(response)
	}
})
