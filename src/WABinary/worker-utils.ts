export const bufferToTransferable = (buf: Buffer): any => {
	// Fast path: buffer owns its entire backing store — return as-is, zero-copy.
	// While a Buffer is not transferable, an ArrayBuffer is:
	if (buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength) {
		return buf.buffer
	}

	// Sub-view case (e.g. Node.js internal Buffer pool): the Buffer shares its
	// backing ArrayBuffer with other allocations, so we cannot transfer it as-is.
	// ArrayBuffer.slice() is the only standard way to produce an isolated,
	// transferable ArrayBuffer from a sub-range — the copy here is unavoidable.
	return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}
