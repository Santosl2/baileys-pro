export async function yieldEventLoop() {
	await new Promise<void>(resolve => setImmediate(resolve))
}
