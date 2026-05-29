/**
 * 10 clients exchanging messages with one another through the fake server.
 *
 * Demonstrates:
 *   - peer-to-peer routing inside the fake server (via the scenario hook)
 *   - 90 cross-client deliveries (10 senders × 9 recipients)
 *   - no errors, no dropped frames, every recipient acked
 */

import type { BinaryNode } from '../../src/WABinary'
import {
	FakeWAServer,
	installTestCerts,
	uninstallTestCerts,
	ClientSwarm,
	composeScenarios,
	defaultLoggedInScenario
} from '../src'

const NUM_CLIENTS = 100
const TEST_TAG = 'chat-test'

describe('peer messaging — 10 clients', () => {
	let server: FakeWAServer
	let swarm: ClientSwarm

	beforeAll(() => {
		installTestCerts()
	})

	afterAll(() => {
		uninstallTestCerts()
	})

	afterEach(async () => {
		if (swarm) {
			await swarm.closeAll()
		}
		if (server) {
			await server.close()
		}
	})

	it('routes a message from every client to every other client without errors', async () => {
		server = new FakeWAServer()

		// Routing scenario: forward any `chat-test` stanza addressed via `to=`
		// to the recipient client, and ack the sender. Falls back to the
		// default logged-in scenario for every other tag so the handshake +
		// keep-alives still work.
		server.setScenario(
			composeScenarios(
				{
					name: 'peer-router',
					onNode: (node, ctx) => {
						if (node.tag !== TEST_TAG) {
							return null
						}
						const to = node.attrs.to
						const id = node.attrs.id
						if (!to || !id) {
							return null
						}
						const target = server.findConnectionByJid(to)
						if (target) {
							// Re-frame with the sender's JID so the recipient
							// knows where it came from.
							const forwarded: BinaryNode = {
								tag: TEST_TAG,
								attrs: {
									from: `${ctx.identity.user}@s.whatsapp.net`,
									to,
									id
								},
								content: node.content
							}
							void target.send(forwarded)
						}
						return {
							tag: 'ack',
							attrs: {
								id,
								to,
								class: TEST_TAG,
								...(target ? {} : { error: 'recipient-offline' })
							}
						}
					}
				},
				defaultLoggedInScenario()
			)
		)

		await server.listen()

		swarm = new ClientSwarm(server.url)
		// Use numeric usernames — Baileys serialises `creds.me.id` into the
		// noise `ClientPayload.username` field as `+user`. Non-numeric users
		// would all collapse to `NaN` and the server would not be able to
		// tell the clients apart.
		await swarm.spawn(NUM_CLIENTS, '551100000010')
		await swarm.waitAllOpen(20_000)

		// Track errors on every client; the test fails if any of them fires.
		const clientErrors: Array<{ client: string; err: unknown }> = []
		for (const c of swarm.all) {
			c.socket.ev.on('connection.update', u => {
				if (u.lastDisconnect?.error) {
					clientErrors.push({ client: c.id, err: u.lastDisconnect.error })
				}
			})
		}

		// Each client subscribes to inbound `chat-test` nodes.
		const inbox = new Map<string, BinaryNode[]>()
		const handlers = new Map<string, (n: BinaryNode) => void>()
		for (const c of swarm.all) {
			inbox.set(c.id, [])
			const h = (n: BinaryNode): void => {
				inbox.get(c.id)!.push(n)
			}
			handlers.set(c.id, h)
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			;(c.socket.ws as any).on(`CB:${TEST_TAG}`, h)
		}

		// Wait a tick to make sure the post-success setup on every client
		// has settled before we start blasting frames.
		await new Promise(r => setTimeout(r, 100))

		// Each client sends one message to every other client.
		const sends: Array<Promise<void>> = []
		for (const sender of swarm.all) {
			const senderUser = sender.creds.me!.id.split('@')[0].split(':')[0]
			for (const recipient of swarm.all) {
				if (recipient === sender) {
					continue
				}
				const recipientUser = recipient.creds.me!.id.split('@')[0].split(':')[0]
				const id = `m-${senderUser}-${recipientUser}`
				sends.push(
					Promise.resolve().then(() =>
						// eslint-disable-next-line @typescript-eslint/no-explicit-any
						(sender.socket as any).sendNode({
							tag: TEST_TAG,
							attrs: {
								to: `${recipientUser}@s.whatsapp.net`,
								id,
								type: 'text'
							},
							content: Buffer.from(`hello from ${senderUser} to ${recipientUser}`)
						})
					)
				)
			}
		}

		await Promise.all(sends)

		// Allow up to 5 s for the server to route every message back out.
		const expectedPerClient = NUM_CLIENTS - 1
		const deadline = Date.now() + 5_000
		while (Date.now() < deadline) {
			const done = [...inbox.values()].every(arr => arr.length >= expectedPerClient)
			if (done) {
				break
			}
			await new Promise(r => setTimeout(r, 50))
		}

		// Cleanup subscribers before assertions so a failed assertion does
		// not leak listeners.
		for (const c of swarm.all) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			;(c.socket.ws as any).off?.(`CB:${TEST_TAG}`, handlers.get(c.id))
		}

		// Per-client receipt counts.
		const counts = [...inbox.entries()].map(([id, arr]) => ({ id, n: arr.length }))
		const totalReceived = counts.reduce((s, c) => s + c.n, 0)
		const totalExpected = NUM_CLIENTS * (NUM_CLIENTS - 1)

		expect(clientErrors).toEqual([])
		expect(counts.every(c => c.n === expectedPerClient)).toBe(true)
		expect(totalReceived).toBe(totalExpected)

		// Server-side sanity.
		const snap = server.metrics.snapshot()
		expect(snap.counters['handshakes.completed']).toBe(NUM_CLIENTS)
		expect(snap.counters['frames.dropped'] ?? 0).toBe(0)
	}, 45_000)
})
