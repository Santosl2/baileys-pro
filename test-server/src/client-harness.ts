/**
 * client-harness.ts — spawns N Baileys clients pointed at the fake server.
 *
 * Each client gets an isolated, pre-seeded in-memory auth state so the
 * `<success/>` path is exercised and the QR-pair flow is skipped.
 */

import { EventEmitter } from 'events'
import { URL } from 'url'
import makeWASocket from '../../src/Socket'
import { DEFAULT_CONNECTION_CONFIG } from '../../src/Defaults'
import type { AuthenticationCreds, AuthenticationState, SignalKeyStore } from '../../src/Types'
import { initAuthCreds } from '../../src/Utils/auth-utils'
import { makeTestLogger, type TestLogger } from './logger'

type AnySocket = ReturnType<typeof makeWASocket>

/**
 * Pure in-memory signal key store. Suitable for tests; not persistent.
 */
const makeInMemoryKeyStore = (): SignalKeyStore => {
	const data = new Map<string, Map<string, unknown>>()
	return {
		get: async (type, ids) => {
			const bucket = data.get(type) ?? new Map<string, unknown>()
			const out: Record<string, unknown> = {}
			for (const id of ids) {
				if (bucket.has(id)) {
					out[id] = bucket.get(id)
				}
			}
			return out as never
		},
		set: async values => {
			for (const type of Object.keys(values) as Array<keyof typeof values>) {
				const bucket = data.get(type as string) ?? new Map<string, unknown>()
				const entries = values[type] as Record<string, unknown> | undefined
				if (!entries) {
					continue
				}
				for (const id of Object.keys(entries)) {
					const v = entries[id]
					if (v === null || v === undefined) {
						bucket.delete(id)
					} else {
						bucket.set(id, v)
					}
				}
				data.set(type as string, bucket)
			}
		},
		clear: async () => {
			data.clear()
		}
	}
}

export type FakeClientOptions = {
	url: string
	user?: string
	device?: number
	logger?: TestLogger
}

export type FakeClient = {
	id: string
	socket: AnySocket
	creds: AuthenticationCreds
	close: () => Promise<void>
	waitOpen: (timeoutMs?: number) => Promise<void>
}

/** Seeds an auth credential set as if the device had already paired. */
export const makePreSeededCreds = (user: string, device: number): AuthenticationCreds => {
	const creds = initAuthCreds()
	creds.registered = true
	creds.me = {
		id: `${user}:${device}@s.whatsapp.net`,
		name: `fake-user-${user}`,
		lid: `${user}.0:${device}@lid`
	}
	creds.account = {
		details: new Uint8Array(0),
		accountSignatureKey: creds.signedIdentityKey.public,
		accountSignature: new Uint8Array(64),
		deviceSignature: new Uint8Array(64)
	}
	creds.platform = 'web'
	creds.signalIdentities = []
	return creds
}

/**
 * Boots a single Baileys client connected to the fake server.
 *
 * Important: pass `fireInitQueries: false` so the client does not try to
 * execute the full WhatsApp post-login query bundle (most of which the
 * fake server does not implement). Set it to `true` only if your scenario
 * acknowledges every IQ.
 */
export const startFakeClient = async (opts: FakeClientOptions): Promise<FakeClient> => {
	const id = `${opts.user ?? Math.floor(Math.random() * 1e9)}:${opts.device ?? 0}`
	const creds = makePreSeededCreds(
		opts.user ?? id.split(':')[0]!,
		opts.device ?? 0
	)
	const keys = makeInMemoryKeyStore()
	const auth: AuthenticationState = { creds, keys }
	const logger = opts.logger ?? makeTestLogger(`client[${id}]`, 'warn')

	const socket = makeWASocket({
		...DEFAULT_CONNECTION_CONFIG,
		waWebSocketUrl: new URL(opts.url),
		auth,
		logger,
		printQRInTerminal: false,
		fireInitQueries: false,
		markOnlineOnConnect: false,
		syncFullHistory: false,
		// Faster timeouts — tests should fail loudly rather than hang.
		connectTimeoutMs: 10_000,
		defaultQueryTimeoutMs: 10_000,
		keepAliveIntervalMs: 30_000
	})

	const waitOpen = (timeoutMs = 15_000): Promise<void> =>
		new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				cleanup()
				reject(new Error(`client ${id} did not reach 'open' within ${timeoutMs}ms`))
			}, timeoutMs)
			const listener = (update: { connection?: string }): void => {
				if (update.connection === 'open') {
					cleanup()
					resolve()
				} else if (update.connection === 'close') {
					cleanup()
					reject(new Error(`client ${id} closed before 'open'`))
				}
			}
			socket.ev.on('connection.update', listener)
			const cleanup = (): void => {
				clearTimeout(timer)
				socket.ev.off('connection.update', listener)
			}
		})

	const close = async (): Promise<void> => {
		try {
			socket.end(undefined)
		} catch {
			/* ignore */
		}
	}

	return { id, socket, creds, close, waitOpen }
}

/**
 * Convenience helper: spin up `N` clients in parallel, all targeting the
 * supplied URL. Returns a control bundle for the caller.
 */
export class ClientSwarm extends EventEmitter {
	private readonly clients: FakeClient[] = []

	constructor(
		private readonly url: string,
		private readonly logger: TestLogger = makeTestLogger('swarm')
	) {
		super()
	}

	get size(): number {
		return this.clients.length
	}

	get all(): ReadonlyArray<FakeClient> {
		return this.clients
	}

	async spawn(count: number, userPrefix = 'u', startIndex = 0): Promise<FakeClient[]> {
		const spawned = await Promise.all(
			Array.from({ length: count }, (_, i) =>
				startFakeClient({
					url: this.url,
					user: `${userPrefix}${startIndex + i}`,
					device: 0
				})
			)
		)
		this.clients.push(...spawned)
		this.logger.info({ count: spawned.length, total: this.clients.length }, 'spawned clients')
		return spawned
	}

	async waitAllOpen(timeoutMs = 30_000): Promise<void> {
		await Promise.all(this.clients.map(c => c.waitOpen(timeoutMs)))
	}

	async closeAll(): Promise<void> {
		await Promise.all(this.clients.map(c => c.close()))
		this.clients.length = 0
	}
}
