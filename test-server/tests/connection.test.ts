/**
 * Verifies the end-to-end handshake: a real Baileys client connecting to the
 * fake server should reach `connection: 'open'`.
 */
import { installTestCerts, uninstallTestCerts, FakeWAServer, startFakeClient } from '../src'

describe('connection (basic)', () => {
	let server: FakeWAServer

	beforeAll(() => {
		installTestCerts()
	})
	afterAll(() => {
		uninstallTestCerts()
	})

	beforeEach(async () => {
		server = new FakeWAServer()
		await server.listen()
	})
	afterEach(async () => {
		await server.close()
	})

	it('completes the noise handshake and emits connection.open', async () => {
		const client = await startFakeClient({ url: server.url, user: '5511999999990' })
		await client.waitOpen(15_000)
		expect(server.metrics.get('handshakes.completed')).toBe(1)
		expect(server.metrics.get('handshakes.failed')).toBe(0)
		await client.close()
	})

	it('handles many parallel handshakes', async () => {
		const N = 25
		const clients = await Promise.all(
			Array.from({ length: N }, (_, i) =>
				startFakeClient({ url: server.url, user: `u${i}` })
			)
		)
		await Promise.all(clients.map(c => c.waitOpen(20_000)))
		expect(server.metrics.get('handshakes.completed')).toBe(N)
		expect(server.activeConnections).toBe(N)
		await Promise.all(clients.map(c => c.close()))
	})
})
