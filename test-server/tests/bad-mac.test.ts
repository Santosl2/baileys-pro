/**
 * Bad-MAC / corrupt-frame simulation. The fault injector tampers with the
 * AES-GCM authentication tag of an outbound frame; the client's Noise
 * transport detects the integrity violation and tears the connection down.
 */

import {
	FakeWAServer,
	installTestCerts,
	uninstallTestCerts,
	startFakeClient,
	composeScenarios,
	defaultLoggedInScenario
} from '../src'

describe('bad MAC simulation', () => {
	beforeAll(() => {
		installTestCerts()
	})

	afterAll(() => {
		uninstallTestCerts()
	})

	it('client errors out when the server corrupts an outbound frame', async () => {
		// Force every outbound frame addressed to a custom `mac-test` query
		// to be corrupted. All other traffic flows normally so the handshake
		// + `<success/>` greeting are delivered intact.
		const server = new FakeWAServer({
			fault: {
				decider: ctx => {
					if (
						ctx.direction === 'outbound' &&
						ctx.node?.tag === 'iq' &&
						ctx.node.attrs.id === 'mac-test'
					) {
						return 'corrupt'
					}
					return undefined
				}
			},
			scenario: composeScenarios(
				{
					name: 'mac-test-replier',
					onNode: (node, _ctx) => {
						if (node.tag === 'iq' && node.attrs.id === 'mac-test') {
							return {
								tag: 'iq',
								attrs: {
									from: 's.whatsapp.net',
									type: 'result',
									id: 'mac-test'
								},
								content: [{ tag: 'ok', attrs: {} }]
							}
						}
						return null
					}
				},
				defaultLoggedInScenario()
			)
		})

		await server.listen()

		try {
			const client = await startFakeClient({
				url: server.url,
				user: '5511000099001'
			})

			await client.waitOpen(15_000)

			// Capture the disconnect that the bad-MAC will trigger.
			const disconnected = new Promise<unknown>(resolve => {
				client.socket.ev.on('connection.update', u => {
					if (u.connection === 'close') {
						resolve(u.lastDisconnect?.error)
					}
				})
			})

			// Fire a query whose reply will be corrupted in flight.
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			void (client.socket as any).sendNode({
				tag: 'iq',
				attrs: {
					id: 'mac-test',
					type: 'get',
					to: 's.whatsapp.net',
					xmlns: 'w'
				}
			})

			const err = await Promise.race([
				disconnected,
				new Promise((_r, reject) =>
					setTimeout(() => reject(new Error('client did not disconnect after bad MAC')), 10_000)
				)
			])

			expect(err).toBeDefined()
			expect(server.metrics.snapshot().counters['frames.corrupted']).toBeGreaterThanOrEqual(1)

			await client.close()
		} finally {
			await server.close()
		}
	}, 30_000)
})
