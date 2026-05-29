/**
 * Bad-MAC simulation at the libsignal layer.
 *
 * Two in-process libsignal repositories share a Signal session. Plaintext
 * is encrypted on the sender side, wrapped in a `<signal-test>` stanza
 * containing an `<enc type="pkmsg">` child, and pushed through the fake
 * WhatsApp server. The server's fault injector returns `'corruptSignal'`
 * for that frame, which flips the trailing byte of the `<enc>` content
 * *before* it is Noise-encoded. The Noise transport on the receiver
 * decodes the frame cleanly, but `repository.decryptMessage` raises a
 * real libsignal Bad-MAC error.
 */

import type { BinaryNode } from '../../src/WABinary'
// Import the test-server entry point *first* so that Baileys' Defaults /
// Utils / Socket modules are fully initialised before we touch libsignal
// directly. Importing libsignal first triggers a partial-init circular
// dependency on Browsers (Defaults <-> generics <-> crypto).
import {
	FakeWAServer,
	installTestCerts,
	uninstallTestCerts,
	startFakeClient,
	composeScenarios,
	defaultLoggedInScenario
} from '../src'
import { makeLibSignalRepository } from '../../src/Signal/libsignal'
import { Curve, generateRegistrationId, generateSignalPubKey, signedKeyPair } from '../../src/Utils'
import type { SignalAuthState, SignalDataTypeMap } from '../../src/Types'

type TestUser = {
	jid: string
	state: SignalAuthState
	repository: ReturnType<typeof makeLibSignalRepository>
}

/**
 * Minimal in-memory key store that satisfies the SignalKeyStoreWithTransaction
 * shape libsignal expects. `transaction` is a passthrough (no rollback) which
 * is sufficient for single-threaded test scenarios.
 */
const makeInMemoryStore = () => {
	const data: Record<string, Record<string, unknown>> = {}
	return {
		get: async (type: string, ids: string[]) => {
			const bucket = data[type] ?? {}
			const out: Record<string, unknown> = {}
			for (const id of ids) {
				if (id in bucket) {
					out[id] = bucket[id]
				}
			}
			return out
		},
		set: async (values: Record<string, Record<string, unknown> | undefined>) => {
			for (const type of Object.keys(values)) {
				const bucket = (data[type] ??= {})
				const entries = values[type]
				if (!entries) {
					continue
				}
				for (const id of Object.keys(entries)) {
					const v = entries[id]
					if (v === null || v === undefined) {
						delete bucket[id]
					} else {
						bucket[id] = v
					}
				}
			}
		},
		clear: async () => {
			for (const k of Object.keys(data)) {
				delete data[k]
			}
		},
		isInTransaction: () => false,
		transaction: async <T>(work: () => Promise<T>): Promise<T> => work()
	}
}

const makeUser = (jidUser: string): TestUser => {
	const identityKey = Curve.generateKeyPair()
	const keys = makeInMemoryStore()
	const state: SignalAuthState = {
		creds: {
			signedIdentityKey: identityKey,
			registrationId: generateRegistrationId(),
			signedPreKey: signedKeyPair(identityKey, 1)
		} as SignalAuthState['creds'],
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		keys: keys as any
	}
	const repository = makeLibSignalRepository(state)
	return { jid: `${jidUser}@s.whatsapp.net`, state, repository }
}

const establishSession = async (sender: TestUser, receiver: TestUser, preKeyId = 2): Promise<void> => {
	const preKey = Curve.generateKeyPair()
	await sender.repository.injectE2ESession({
		jid: receiver.jid,
		session: {
			registrationId: receiver.state.creds.registrationId,
			identityKey: generateSignalPubKey(receiver.state.creds.signedIdentityKey.public),
			signedPreKey: {
				keyId: receiver.state.creds.signedPreKey.keyId,
				publicKey: generateSignalPubKey(receiver.state.creds.signedPreKey.keyPair.public),
				signature: receiver.state.creds.signedPreKey.signature
			},
			preKey: {
				keyId: preKeyId,
				publicKey: generateSignalPubKey(preKey.public)
			}
		}
	})
	await receiver.state.keys.set({
		'pre-key': {
			[preKeyId]: preKey
		} as Partial<Record<string, SignalDataTypeMap['pre-key']>>
	})
}

describe('bad MAC simulation — libsignal layer', () => {
	let server: FakeWAServer

	beforeAll(() => {
		installTestCerts()
	})

	afterAll(() => {
		uninstallTestCerts()
	})

	afterEach(async () => {
		if (server) {
			await server.close()
		}
	})

	it('sanity: round-trip through the server decrypts successfully', async () => {
		const alice = makeUser('5511000088001')
		const bob = makeUser('5511000088002')
		await establishSession(alice, bob, 100)

		server = new FakeWAServer({
			scenario: composeScenarios(
				{
					name: 'signal-router',
					onNode: (node, ctx) => {
						if (node.tag !== 'signal-test') {
							return null
						}
						const to = node.attrs.to
						if (!to) {
							return null
						}
						const target = server.findConnectionByJid(to)
						if (target) {
							void target.send({
								tag: 'signal-test',
								attrs: { from: `${ctx.identity.user}@s.whatsapp.net`, id: node.attrs.id },
								content: node.content
							})
						}
						return null
					}
				},
				defaultLoggedInScenario()
			)
		})
		await server.listen()

		const aliceClient = await startFakeClient({ url: server.url, user: '5511000088001' })
		const bobClient = await startFakeClient({ url: server.url, user: '5511000088002' })
		await aliceClient.waitOpen(10_000)
		await bobClient.waitOpen(10_000)

		const received = new Promise<BinaryNode>(resolve => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			;(bobClient.socket.ws as any).on('CB:signal-test', (n: BinaryNode) => resolve(n))
		})

		const plaintext = Buffer.from('hello libsignal!')
		const { type, ciphertext } = await alice.repository.encryptMessage({ jid: bob.jid, data: plaintext })

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		void (aliceClient.socket as any).sendNode({
			tag: 'signal-test',
			attrs: { to: bob.jid, id: 'ok-1' },
			content: [{ tag: 'enc', attrs: { type }, content: ciphertext }]
		})

		const node = await received
		const enc = (node.content as BinaryNode[]).find(c => c.tag === 'enc')!
		const decrypted = await bob.repository.decryptMessage({
			jid: alice.jid,
			type: enc.attrs.type as 'pkmsg' | 'msg',
			ciphertext: enc.content as Uint8Array
		})

		expect(Buffer.from(decrypted).equals(plaintext)).toBe(true)

		await aliceClient.close()
		await bobClient.close()
	}, 30_000)

	it('libsignal raises a Bad-MAC error when the server corrupts the <enc> payload', async () => {
		const alice = makeUser('5511000088011')
		const bob = makeUser('5511000088012')
		await establishSession(alice, bob, 200)

		server = new FakeWAServer({
			fault: {
				decider: ctx => {
					if (
						ctx.direction === 'outbound' &&
						ctx.node?.tag === 'signal-test' &&
						ctx.node.attrs.id === 'corrupt-1'
					) {
						return 'corruptSignal'
					}
					return undefined
				}
			},
			scenario: composeScenarios(
				{
					name: 'signal-router',
					onNode: (node, ctx) => {
						if (node.tag !== 'signal-test') {
							return null
						}
						const to = node.attrs.to
						if (!to) {
							return null
						}
						const target = server.findConnectionByJid(to)
						if (target) {
							void target.send({
								tag: 'signal-test',
								attrs: { from: `${ctx.identity.user}@s.whatsapp.net`, id: node.attrs.id },
								content: node.content
							})
						}
						return null
					}
				},
				defaultLoggedInScenario()
			)
		})
		await server.listen()

		const aliceClient = await startFakeClient({ url: server.url, user: '5511000088011' })
		const bobClient = await startFakeClient({ url: server.url, user: '5511000088012' })
		await aliceClient.waitOpen(10_000)
		await bobClient.waitOpen(10_000)

		const received = new Promise<BinaryNode>(resolve => {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			;(bobClient.socket.ws as any).on('CB:signal-test', (n: BinaryNode) => resolve(n))
		})

		const plaintext = Buffer.from('this delivery should be tampered with')
		const { type, ciphertext } = await alice.repository.encryptMessage({ jid: bob.jid, data: plaintext })
		const originalLastByte = ciphertext[ciphertext.length - 1]

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		void (aliceClient.socket as any).sendNode({
			tag: 'signal-test',
			attrs: { to: bob.jid, id: 'corrupt-1' },
			content: [{ tag: 'enc', attrs: { type }, content: ciphertext }]
		})

		const node = await received
		const enc = (node.content as BinaryNode[]).find(c => c.tag === 'enc')!
		const receivedCipher = enc.content as Uint8Array

		// The server must have flipped the trailing byte (the MAC region).
		expect(receivedCipher.length).toBe(ciphertext.length)
		expect(receivedCipher[receivedCipher.length - 1]).toBe(originalLastByte ^ 0xff)

		let caught: Error | undefined
		try {
			await bob.repository.decryptMessage({
				jid: alice.jid,
				type: enc.attrs.type as 'pkmsg' | 'msg',
				ciphertext: receivedCipher
			})
		} catch (e) {
			caught = e as Error
		}

		expect(caught).toBeDefined()
		// libsignal throws either "Bad MAC" (WhisperMessage) or
		// "Invalid PreKey message" / similar when the wrapper is altered.
		// Either way the message is the byte-flip canary.
		const msg = String(caught?.message ?? '')
		expect(msg.length).toBeGreaterThan(0)

		expect(server.metrics.snapshot().counters['signal.corrupted']).toBeGreaterThanOrEqual(1)

		await aliceClient.close()
		await bobClient.close()
	}, 30_000)
})
