/**
 * Fault injection — verify the deterministic decider hooks correctly drop,
 * duplicate and fail traffic.
 */
import { S_WHATSAPP_NET } from '../../src/WABinary'
import {
	FakeWAServer,
	installTestCerts,
	uninstallTestCerts,
	startFakeClient,
	defaultLoggedInScenario,
	composeScenarios,
	replyIqResult
} from '../src'

describe('fault-injector', () => {
	beforeAll(() => installTestCerts())
	afterAll(() => uninstallTestCerts())

	const pingScenario = () =>
		composeScenarios(
			{
				name: 'ping',
				onNode: n => (n.tag === 'iq' && n.attrs.xmlns === 'ping' ? replyIqResult(n) : null)
			},
			defaultLoggedInScenario()
		)

	it('drops every outbound ping reply when decider returns drop', async () => {
		const server = new FakeWAServer({
			scenario: pingScenario(),
			fault: {
				decider: ctx => (ctx.direction === 'outbound' && ctx.node?.tag === 'iq' ? 'drop' : 'allow')
			}
		})
		await server.listen()

		const client = await startFakeClient({ url: server.url, user: 'drop-test' })
		await client.waitOpen()

		await expect(
			client.socket.query(
				{
					tag: 'iq',
					attrs: {
						to: S_WHATSAPP_NET,
						type: 'get',
						xmlns: 'ping',
						id: 'drop-1'
					}
				},
				1_000
			)
		).rejects.toBeDefined()

		expect(server.metrics.get('frames.dropped')).toBeGreaterThan(0)

		await client.close()
		await server.close()
	})

	it('replies with iq error when decider returns error', async () => {
		const server = new FakeWAServer({
			scenario: pingScenario(),
			fault: {
				decider: ctx => (ctx.direction === 'inbound' && ctx.node?.tag === 'iq' ? 'error' : 'allow')
			}
		})
		await server.listen()

		const client = await startFakeClient({ url: server.url, user: 'err-test' })
		await client.waitOpen()

		await expect(
			client.socket.query(
				{
					tag: 'iq',
					attrs: {
						to: S_WHATSAPP_NET,
						type: 'get',
						xmlns: 'ping',
						id: 'err-1'
					}
				},
				3_000
			)
		).rejects.toBeDefined()

		expect(server.metrics.get('iqs.errored')).toBeGreaterThan(0)

		await client.close()
		await server.close()
	})

	it('disconnects the client when fault decider returns disconnect', async () => {
		const server = new FakeWAServer({
			scenario: pingScenario(),
			fault: {
				decider: ctx => (ctx.direction === 'inbound' && ctx.node?.tag === 'iq' ? 'disconnect' : 'allow')
			}
		})
		await server.listen()

		const client = await startFakeClient({ url: server.url, user: 'disc-test' })
		await client.waitOpen()

		const closedPromise = new Promise<void>(resolve => {
			const listener = (update: { connection?: string }): void => {
				if (update.connection === 'close') {
					client.socket.ev.off('connection.update', listener)
					resolve()
				}
			}
			client.socket.ev.on('connection.update', listener)
		})

		void client.socket
			.query(
				{
					tag: 'iq',
					attrs: {
						to: S_WHATSAPP_NET,
						type: 'get',
						xmlns: 'ping',
						id: 'd-1'
					}
				},
				2_000
			)
			.catch(() => undefined)

		await closedPromise
		expect(server.metrics.get('forced.disconnects')).toBeGreaterThan(0)

		await client.close()
		await server.close()
	})
})
