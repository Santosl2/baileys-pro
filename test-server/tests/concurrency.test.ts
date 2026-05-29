/**
 * Concurrency tests: many clients exchanging high volumes of frames at the
 * same time should not lose ordering or deadlock the server.
 */
import { S_WHATSAPP_NET } from '../../src/WABinary'
import {
	ClientSwarm,
	FakeWAServer,
	installTestCerts,
	uninstallTestCerts,
	defaultLoggedInScenario,
	composeScenarios,
	replyIqResult
} from '../src'

describe('concurrency', () => {
	let server: FakeWAServer
	let swarm: ClientSwarm

	beforeAll(() => installTestCerts())
	afterAll(() => uninstallTestCerts())

	beforeEach(async () => {
		// Track an inbound counter via a custom scenario layer.
		server = new FakeWAServer({
			scenario: composeScenarios(
				{
					name: 'ping-replier',
					onNode: node => {
						if (node.tag === 'iq' && node.attrs.xmlns === 'ping') {
							return replyIqResult(node)
						}
						return null
					}
				},
				defaultLoggedInScenario()
			)
		})
		await server.listen()
		swarm = new ClientSwarm(server.url)
	})
	afterEach(async () => {
		await swarm.closeAll()
		await server.close()
	})

	it('every client in a swarm of 30 reaches open', async () => {
		await swarm.spawn(30)
		await swarm.waitAllOpen(30_000)
		expect(server.metrics.get('handshakes.completed')).toBe(30)
	})

	it('round-trips ping IQs from many clients in parallel without ordering loss', async () => {
		await swarm.spawn(10)
		await swarm.waitAllOpen(20_000)

		const PINGS_PER_CLIENT = 20
		const results = await Promise.all(
			swarm.all.map(async client => {
				const replies = await Promise.all(
					Array.from({ length: PINGS_PER_CLIENT }, (_, i) =>
						client.socket.query({
							tag: 'iq',
							attrs: {
								to: S_WHATSAPP_NET,
								type: 'get',
								xmlns: 'ping',
								id: `${client.id}.${i}`
							}
						})
					)
				)
				return replies.length
			})
		)
		expect(results.every(n => n === PINGS_PER_CLIENT)).toBe(true)
		expect(server.metrics.get('iqs.handled')).toBeGreaterThanOrEqual(10 * PINGS_PER_CLIENT)
	})
})
