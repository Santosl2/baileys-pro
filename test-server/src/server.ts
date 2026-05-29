/**
 * server.ts — `FakeWAServer`: a WhatsApp-compatible Noise WebSocket server
 * usable as a target for live Baileys clients during E2E concurrency tests.
 *
 * Lifecycle (per client):
 *   1. WS upgrade.
 *   2. Receive first inbound chunk → strip NOISE_WA_HEADER → extract
 *      clientHello frame.
 *   3. Run server-side Noise XX → reply with serverHello.
 *   4. Receive clientFinish frame, derive transport state.
 *   5. Emit scenario `onConnected` frames (typically `<success/>`).
 *   6. Pump transport frames through the fault injector and scenario hooks.
 */

import { EventEmitter } from 'events'
import { createServer, type Server as HttpServer } from 'http'
import { type AddressInfo } from 'net'
import { WebSocket, WebSocketServer } from 'ws'
import { proto } from '../../WAProto'
import type { KeyPair } from '../../src/Types'
import type { BinaryNode } from '../../src/WABinary'
import { binaryNodeToString } from '../../src/WABinary'
import { Curve } from '../../src/Utils/crypto'
import { FaultInjector, sleep, type FaultConfig } from './fault-injector'
import { Metrics } from './metrics'
import { makeTestLogger, type TestLogger } from './logger'
import { makeServerNoise, parseFirstFrame, parseRawFrame, type ServerNoise } from './server-noise'
import { defaultLoggedInScenario, type Scenario } from './scenarios'

export type ServerIdentity = {
	user: string
	device: number
	lid?: string
}

export type ConnectionContext = {
	readonly clientId: string
	readonly identity: ServerIdentity
	/** Send a binary node back to this specific client. */
	send: (node: BinaryNode) => Promise<void>
	/** Forcibly close the connection (server side). */
	close: (code?: number, reason?: string) => void
	readonly clientPayload: proto.IClientPayload
}

export type FakeServerOptions = {
	host?: string
	port?: number
	logger?: TestLogger
	scenario?: Scenario
	fault?: Partial<FaultConfig>
	/**
	 * Maps the username (from the `ClientPayload.username` int64 field of
	 * the noise client payload) to a server-side identity. By default the
	 * identity is `{ user: String(username), device: 0 }`.
	 */
	identityResolver?: (payload: proto.IClientPayload) => ServerIdentity
	/** Maximum simultaneous connections (rejected with 1013 after the cap). */
	maxConnections?: number
}

export type ServerEvents = {
	listening: { url: string; port: number }
	connection: { clientId: string; identity: ServerIdentity }
	disconnect: { clientId: string; reason: string }
	frame: { clientId: string; direction: 'in' | 'out'; node: BinaryNode }
	error: { clientId?: string; error: Error }
}

export interface FakeWAServer extends EventEmitter {
	on<K extends keyof ServerEvents>(event: K, listener: (payload: ServerEvents[K]) => void): this
	emit<K extends keyof ServerEvents>(event: K, payload: ServerEvents[K]): boolean
}

export class FakeWAServer extends EventEmitter {
	readonly metrics = new Metrics()
	readonly fault: FaultInjector
	private readonly logger: TestLogger
	private scenario: Scenario
	private readonly identityResolver: NonNullable<FakeServerOptions['identityResolver']>
	private readonly maxConnections: number
	private readonly host: string
	private readonly requestedPort: number
	private readonly serverStatic: KeyPair = Curve.generateKeyPair()

	private httpServer: HttpServer | null = null
	private wss: WebSocketServer | null = null
	private boundPort = 0
	private readonly connections = new Map<string, ConnectionContext>()
	private nextClientSeq = 0
	private closed = false

	constructor(opts: FakeServerOptions = {}) {
		super()
		this.setMaxListeners(0)
		this.host = opts.host ?? '127.0.0.1'
		this.requestedPort = opts.port ?? 0
		this.logger = opts.logger ?? makeTestLogger('fake-wa-server')
		this.scenario = opts.scenario ?? defaultLoggedInScenario()
		this.fault = new FaultInjector(opts.fault ?? {})
		this.identityResolver =
			opts.identityResolver ??
			(payload => ({
				user: String(payload.username ?? '0'),
				device: Number(payload.device ?? 0)
			}))
		this.maxConnections = opts.maxConnections ?? 10_000
	}

	get port(): number {
		return this.boundPort
	}

	get url(): string {
		return `ws://${this.host}:${this.boundPort}`
	}

	get activeConnections(): number {
		return this.connections.size
	}

	listen(): Promise<{ url: string; port: number }> {
		if (this.httpServer) {
			throw new Error('Server already started')
		}
		return new Promise((resolve, reject) => {
			const httpServer = createServer()
			const wss = new WebSocketServer({ server: httpServer, perMessageDeflate: false })
			wss.on('connection', socket => this.handleConnection(socket))
			wss.on('error', err => this.emit('error', { error: err }))

			httpServer.once('error', reject)
			httpServer.listen(this.requestedPort, this.host, () => {
				const addr = httpServer.address() as AddressInfo
				this.boundPort = addr.port
				this.httpServer = httpServer
				this.wss = wss
				this.emit('listening', { url: this.url, port: this.boundPort })
				resolve({ url: this.url, port: this.boundPort })
			})
		})
	}

	async close(): Promise<void> {
		if (this.closed) {
			return
		}
		this.closed = true
		for (const c of [...this.connections.values()]) {
			c.close(1001, 'server-shutdown')
		}
		await new Promise<void>(resolve => {
			if (!this.wss) {
				return resolve()
			}
			this.wss.close(() => resolve())
		})
		await new Promise<void>(resolve => {
			if (!this.httpServer) {
				return resolve()
			}
			this.httpServer.close(() => resolve())
		})
		this.wss = null
		this.httpServer = null
	}

	/** Broadcast a node to every currently-connected client. */
	async broadcast(node: BinaryNode): Promise<void> {
		await Promise.all([...this.connections.values()].map(c => c.send(node)))
	}

	/** Replace the active scenario at runtime (useful for tests that need
	 * access to the server instance when constructing the scenario). */
	setScenario(scenario: Scenario): void {
		this.scenario = scenario
	}

	/** Iterate over every live connection context. */
	listConnections(): ConnectionContext[] {
		return [...this.connections.values()]
	}

	/** Find a connection by the `user` part of the resolved identity. */
	findConnectionByUser(user: string): ConnectionContext | undefined {
		for (const c of this.connections.values()) {
			if (c.identity.user === user) {
				return c
			}
		}
		return undefined
	}

	/** Find a connection by a JID such as `5511…@s.whatsapp.net` (matches
	 * the `user` segment before any `:device` / `@server`). */
	findConnectionByJid(jid: string): ConnectionContext | undefined {
		const user = jid.split('@')[0].split(':')[0]
		return this.findConnectionByUser(user)
	}

	private handleConnection(ws: WebSocket): void {
		if (this.connections.size >= this.maxConnections) {
			this.metrics.inc('connections.rejected')
			ws.close(1013, 'max-connections')
			return
		}

		const clientId = `c${++this.nextClientSeq}`
		this.metrics.inc('connections.opened')
		this.logger.debug({ clientId }, 'ws upgraded')

		const noise = makeServerNoise()
		let handshakeBuf: Buffer = Buffer.alloc(0)
		let handshakeStage: 'awaiting-hello' | 'awaiting-finish' | 'transport' = 'awaiting-hello'
		let finishHandshake:
			| ((finishBytes: Uint8Array) => Promise<{ clientPayload: proto.IClientPayload }>)
			| null = null
		let identity: ServerIdentity | null = null
		let clientPayload: proto.IClientPayload | null = null
		let ctx: ConnectionContext | null = null
		// Outbound serialisation lock so message ordering is deterministic
		// even under reorder/duplication.
		let outboundChain: Promise<void> = Promise.resolve()

		const closeWith = (code: number, reason: string): void => {
			try {
				ws.close(code, reason)
			} catch {
				/* ignore */
			}
		}

		const sendBytes = (bytes: Uint8Array): Promise<void> =>
			new Promise((resolve, reject) => {
				if (ws.readyState !== WebSocket.OPEN) {
					return reject(new Error('socket-not-open'))
				}
				ws.send(bytes, err => (err ? reject(err) : resolve()))
			})

		const sendNodeImmediate = async (node: BinaryNode): Promise<void> => {
			try {
				const frame = noise.encodeNode(node)
				await sendBytes(frame)
				this.metrics.inc('frames.out')
				this.emit('frame', { clientId, direction: 'out', node })
				if (this.logger.level === 'trace') {
					this.logger.trace({ clientId, xml: binaryNodeToString(node) }, 'send')
				}
			} catch (err) {
				this.emit('error', { clientId, error: err as Error })
			}
		}

		/**
		 * Encode the node, then mutate a byte inside the AES-GCM ciphertext
		 * portion of the encrypted frame so the client's Noise decoder
		 * raises a Bad-MAC / authentication-tag mismatch. The 3-byte frame
		 * length prefix is preserved so the WS layer still routes the
		 * payload to the decoder.
		 */
		const sendNodeCorrupted = async (node: BinaryNode): Promise<void> => {
			try {
				const frame = noise.encodeNode(node)
				const buf = Buffer.from(frame)
				if (buf.length > 3) {
					// Flip the last byte (inside the GCM auth tag) so verification fails.
					buf[buf.length - 1] = buf[buf.length - 1] ^ 0xff
				}
				await sendBytes(buf)
				this.metrics.inc('frames.corrupted')
				this.emit('frame', { clientId, direction: 'out', node })
				if (this.logger.level === 'trace') {
					this.logger.trace({ clientId, xml: binaryNodeToString(node) }, 'send (corrupted)')
				}
			} catch (err) {
				this.emit('error', { clientId, error: err as Error })
			}
		}

		/**
		 * Walk the node and flip the trailing byte of every `<enc>` child's
		 * content. The Signal/libsignal MAC is HMAC-SHA256 truncated to the
		 * last 8 bytes of the ciphertext, so flipping the very last byte
		 * reliably triggers a Bad-MAC error on the receiver's libsignal
		 * decrypt path — without disturbing the outer Noise frame.
		 * Returns true if at least one `<enc>` payload was mutated.
		 */
		const corruptEncChildren = (n: BinaryNode): boolean => {
			let mutated = false
			if (!Array.isArray(n.content)) {
				return mutated
			}
			for (const child of n.content) {
				if (child.tag === 'enc' && child.content instanceof Uint8Array && child.content.length > 0) {
					const buf = Buffer.from(child.content)
					buf[buf.length - 1] = buf[buf.length - 1] ^ 0xff
					child.content = buf
					mutated = true
				}
			}
			return mutated
		}

		const sendNodeSignalCorrupted = async (node: BinaryNode): Promise<void> => {
			const mutated = corruptEncChildren(node)
			if (mutated) {
				this.metrics.inc('signal.corrupted')
			}
			await sendNodeImmediate(node)
		}

		const sendNode = async (node: BinaryNode): Promise<void> => {
			const decision = this.fault.decide({ direction: 'outbound', clientId, node })
			const latency = this.fault.latencyMs()
			const work = (async () => {
				if (latency > 0) {
					await sleep(latency)
				}
				switch (decision) {
					case 'drop':
						this.metrics.inc('frames.dropped')
						return
					case 'duplicate':
						this.metrics.inc('frames.duplicated')
						await sendNodeImmediate(node)
						await sendNodeImmediate(node)
						return
					case 'reorder':
						// Schedule this frame slightly later than the next one
						// by queueing it without blocking the chain.
						this.metrics.inc('frames.reordered')
						setTimeout(() => {
							void sendNodeImmediate(node)
						}, Math.max(1, this.fault.latencyMs() || 5))
						return
					case 'disconnect':
						this.metrics.inc('forced.disconnects')
						closeWith(1011, 'fault-injected-disconnect')
						return
					case 'corrupt':
						await sendNodeCorrupted(node)
						return
					case 'corruptSignal':
						await sendNodeSignalCorrupted(node)
						return
					default:
						await sendNodeImmediate(node)
				}
			})()
			outboundChain = outboundChain.then(() => work).catch(() => undefined)
			return outboundChain
		}

		const finalizeContext = (): ConnectionContext => {
			const c: ConnectionContext = {
				clientId,
				identity: identity!,
				clientPayload: clientPayload!,
				send: node => sendNode(node),
				close: (code, reason) => closeWith(code ?? 1000, reason ?? 'server-close')
			}
			this.connections.set(clientId, c)
			return c
		}

		const dispatchInbound = async (node: BinaryNode): Promise<void> => {
			const decision = this.fault.decide({ direction: 'inbound', clientId, node })
			const proc = this.fault.processingMs()
			if (proc > 0) {
				await sleep(proc)
			}
			this.emit('frame', { clientId, direction: 'in', node })
			this.metrics.inc('frames.in')
			if (this.logger.level === 'trace') {
				this.logger.trace({ clientId, xml: binaryNodeToString(node) }, 'recv')
			}

			if (decision === 'drop') {
				this.metrics.inc('frames.dropped')
				return
			}
			if (decision === 'disconnect') {
				this.metrics.inc('forced.disconnects')
				closeWith(1011, 'fault-injected-disconnect-inbound')
				return
			}
			if (decision === 'error' && node.tag === 'iq') {
				this.metrics.inc('iqs.errored')
				await sendNode({
					tag: 'iq',
					attrs: {
						from: 's.whatsapp.net',
						type: 'error',
						id: node.attrs.id!
					},
					content: [{ tag: 'error', attrs: { code: '503', text: 'fault-injected' } }]
				})
				return
			}

			if (!this.scenario.onNode || !ctx) {
				return
			}
			const reply = await this.scenario.onNode(node, ctx)
			if (!reply) {
				return
			}
			if (node.tag === 'iq') {
				this.metrics.inc('iqs.handled')
			}
			if (Array.isArray(reply)) {
				for (const r of reply) {
					await sendNode(r)
				}
			} else {
				await sendNode(reply)
			}
		}

		const onMessage = async (raw: Buffer): Promise<void> => {
			try {
				if (handshakeStage === 'awaiting-hello') {
					const parsed = parseFirstFrame(raw)
					const { serverHelloBytes, finish } = await noise.processClientHello(
						parsed.frame,
						this.serverStatic
					)
					finishHandshake = finish
					await sendBytes(noise.encodeFrame(serverHelloBytes))
					handshakeStage = 'awaiting-finish'
					if (parsed.rest.length > 0) {
						// Stash any bytes that arrived in the same ws message — the
						// official Baileys client never does this, but a custom
						// client could.
						handshakeBuf = parsed.rest
					}
					return
				}

				if (handshakeStage === 'awaiting-finish') {
					const buf = handshakeBuf.length > 0 ? Buffer.concat([handshakeBuf, raw]) : raw
					handshakeBuf = Buffer.alloc(0)
					const parsed = parseRawFrame(buf)
					if (!parsed) {
						handshakeBuf = buf
						return
					}
					const { clientPayload: cp } = await finishHandshake!(parsed.frame)
					clientPayload = cp
					identity = this.identityResolver(cp)
					handshakeStage = 'transport'
					this.metrics.inc('handshakes.completed')
					ctx = finalizeContext()
					this.emit('connection', { clientId, identity })
					this.logger.info({ clientId, identity }, 'handshake completed')

					if (this.scenario.onConnected) {
						const greeting = await this.scenario.onConnected(ctx)
						for (const g of greeting) {
							await sendNode(g)
						}
					}

					if (parsed.rest.length > 0) {
						await noise.feed(parsed.rest, dispatchInbound)
					}
					return
				}

				// Transport stage: any subsequent message
				await noise.feed(raw, dispatchInbound)
			} catch (err) {
				this.metrics.inc('handshakes.failed')
				this.emit('error', { clientId, error: err as Error })
				this.logger.warn({ clientId, err }, 'message handling failed')
				closeWith(1011, 'server-error')
			}
		}

		ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
			const buf = Array.isArray(data)
				? Buffer.concat(data.map(b => Buffer.from(b)))
				: Buffer.from(data as ArrayBuffer)
			void onMessage(buf)
		})
		ws.on('close', () => {
			this.metrics.inc('connections.closed')
			this.connections.delete(clientId)
			this.emit('disconnect', { clientId, reason: 'close' })
			this.logger.debug({ clientId }, 'ws closed')
		})
		ws.on('error', err => {
			this.emit('error', { clientId, error: err })
		})
	}
}
