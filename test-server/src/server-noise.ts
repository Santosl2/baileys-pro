/**
 * server-noise.ts
 *
 * Server-side Noise_XX_25519_AESGCM_SHA256 handler. Mirrors the math
 * performed by `src/Utils/noise-handler.ts` but from the responder side so
 * that real Baileys clients can complete the WhatsApp handshake against the
 * fake server.
 *
 * Reference: see `processHandshake` in `src/Utils/noise-handler.ts` for the
 * exact sequence the client expects.
 */

import { proto } from '../../WAProto'
import { NOISE_MODE, NOISE_WA_HEADER } from '../../src/Defaults'
import type { KeyPair } from '../../src/Types'
import type { BinaryNode } from '../../src/WABinary'
import { decodeBinaryNode, encodeBinaryNode } from '../../src/WABinary'
import { aesDecryptGCM, aesEncryptGCM, Curve, hkdf, sha256 } from '../../src/Utils/crypto'
import { buildTestCertChainBytes } from './test-cert'

const IV_LENGTH = 12
const EMPTY = Buffer.alloc(0)

const ivOf = (counter: number): Uint8Array => {
	const iv = new Uint8Array(IV_LENGTH)
	const view = new DataView(iv.buffer)
	view.setUint32(8, counter)
	return iv
}

class TransportState {
	private readCounter = 0
	private writeCounter = 0
	private readonly iv = new Uint8Array(IV_LENGTH)

	constructor(
		private readonly encKey: Buffer,
		private readonly decKey: Buffer
	) {}

	private setIv(counter: number): void {
		this.iv[8] = (counter >>> 24) & 0xff
		this.iv[9] = (counter >>> 16) & 0xff
		this.iv[10] = (counter >>> 8) & 0xff
		this.iv[11] = counter & 0xff
	}

	encrypt(plaintext: Uint8Array): Uint8Array {
		this.setIv(this.writeCounter++)
		return aesEncryptGCM(plaintext, this.encKey, this.iv, EMPTY)
	}

	decrypt(ciphertext: Uint8Array): Buffer {
		this.setIv(this.readCounter++)
		return aesDecryptGCM(ciphertext, this.decKey, this.iv, EMPTY) as Buffer
	}
}

export type ServerHandshakeResult = {
	/** Bytes to send to the client as the server-hello frame (NOT framed). */
	serverHelloBytes: Uint8Array
	/** Completes the handshake using the client-finish frame. */
	finish: (clientFinishBytes: Uint8Array) => Promise<{ clientPayload: proto.IClientPayload }>
}

export type ServerNoise = {
	/** Process the incoming client-hello frame and return server-hello bytes. */
	processClientHello: (clientHelloBytes: Uint8Array, serverStaticKey: KeyPair) => Promise<ServerHandshakeResult>
	/** Feed raw bytes received over the WS (post-intro). Frames are surfaced through `onFrame`. */
	feed: (data: Uint8Array, onFrame: (frame: BinaryNode) => void | Promise<void>) => Promise<void>
	/** Encode a binary node into a length-prefixed encrypted transport frame. */
	encodeNode: (node: BinaryNode) => Buffer
	/** Encode arbitrary bytes (used for handshake send). */
	encodeFrame: (data: Uint8Array) => Buffer
	readonly isTransport: boolean
}

export const makeServerNoise = (): ServerNoise => {
	const data = Buffer.from(NOISE_MODE)
	let hash = data.byteLength === 32 ? data : sha256(data)
	let salt = hash
	let encKey = hash
	let decKey = hash
	let counter = 0

	let transport: TransportState | null = null
	let inBuf: Buffer = Buffer.alloc(0)

	const serverEph: KeyPair = Curve.generateKeyPair()

	const authenticate = (b: Uint8Array): void => {
		if (!transport) {
			hash = sha256(Buffer.concat([hash, b]))
		}
	}

	const hsEncrypt = (plaintext: Uint8Array): Uint8Array => {
		const ct = aesEncryptGCM(plaintext, encKey, ivOf(counter++), hash)
		authenticate(ct)
		return ct
	}

	const hsDecrypt = (ciphertext: Uint8Array): Uint8Array => {
		const pt = aesDecryptGCM(ciphertext, decKey, ivOf(counter++), hash)
		authenticate(ciphertext)
		return pt
	}

	const mixIntoKey = async (input: Uint8Array): Promise<void> => {
		const key = await hkdf(Buffer.from(input), 64, { salt, info: '' })
		salt = key.subarray(0, 32)
		encKey = key.subarray(32)
		decKey = key.subarray(32)
		counter = 0
	}

	// Same prologue mixing as the client (see noise-handler.ts bottom of factory).
	authenticate(NOISE_WA_HEADER)
	// The client authenticates its OWN ephemeral public key here. The server
	// must mirror that by authenticating *the client's* ephemeral public key
	// once it arrives in the client-hello.

	const processClientHello = async (
		clientHelloBytes: Uint8Array,
		serverStaticKey: KeyPair
	): Promise<ServerHandshakeResult> => {
		const hello = proto.HandshakeMessage.decode(clientHelloBytes)
		const clientEphPub = hello.clientHello?.ephemeral
		if (!clientEphPub || clientEphPub.length !== 32) {
			throw new Error('Invalid clientHello.ephemeral')
		}

		// Match client's `authenticate(publicKey)` of its ephemeral.
		authenticate(clientEphPub)

		// e (server): authenticate server's ephemeral pub.
		authenticate(serverEph.public)

		// ee
		await mixIntoKey(Curve.sharedKey(serverEph.private, clientEphPub))

		// s (server static, encrypted)
		const serverStaticEnc = hsEncrypt(serverStaticKey.public)

		// es: ECDH(server_static_priv, client_eph_pub)
		await mixIntoKey(Curve.sharedKey(serverStaticKey.private, clientEphPub))

		// payload: encrypted cert chain
		const certChain = buildTestCertChainBytes(serverStaticKey.public)
		const payloadEnc = hsEncrypt(certChain)

		const serverHelloBytes = proto.HandshakeMessage.encode({
			serverHello: {
				ephemeral: serverEph.public,
				static: serverStaticEnc,
				payload: payloadEnc
			}
		}).finish()

		const finish = async (clientFinishBytes: Uint8Array) => {
			const finishMsg = proto.HandshakeMessage.decode(clientFinishBytes)
			const cf = finishMsg.clientFinish
			if (!cf?.static || !cf?.payload) {
				throw new Error('Invalid clientFinish frame')
			}

			const clientStaticPub = hsDecrypt(cf.static)
			if (clientStaticPub.length !== 32) {
				throw new Error('Decoded client static key has wrong length')
			}

			// se: ECDH(server_eph_priv, client_static_pub)
			await mixIntoKey(Curve.sharedKey(serverEph.private, clientStaticPub))

			const clientPayloadBytes = hsDecrypt(cf.payload)
			const clientPayload = proto.ClientPayload.decode(clientPayloadBytes)

			// Derive transport keys. Reader-side (encKey) is what *we* use to
			// encrypt to the client; writer/reader are mirrored vs. client.
			const ts = await hkdf(EMPTY, 64, { salt, info: '' })
			const writeKey = ts.subarray(0, 32)
			const readKey = ts.subarray(32)
			// On the client side, `transport = new TransportState(writeKey, readKey)`,
			// where `writeKey` encrypts client->server and `readKey` decrypts
			// server->client. So the server takes them swapped:
			//   - our encKey = client's readKey
			//   - our decKey = client's writeKey
			transport = new TransportState(readKey, writeKey)
			return { clientPayload }
		}

		return { serverHelloBytes, finish }
	}

	const feed = async (
		data: Uint8Array,
		onFrame: (frame: BinaryNode) => void | Promise<void>
	): Promise<void> => {
		if (!transport) {
			throw new Error('feed() called before transport state was ready')
		}
		const chunk = Buffer.from(data)
		inBuf = inBuf.length === 0 ? chunk : Buffer.concat([inBuf, chunk])

		while (inBuf.length >= 3) {
			const size = (inBuf[0]! << 16) | (inBuf[1]! << 8) | inBuf[2]!
			if (inBuf.length < size + 3) {
				return
			}
			const frame = inBuf.subarray(3, size + 3)
			inBuf = inBuf.subarray(size + 3)

			const decrypted = transport.decrypt(frame)
			const node = await decodeBinaryNode(decrypted)
			await onFrame(node)
		}
	}

	const encodeFrame = (data: Uint8Array): Buffer => {
		const len = data.byteLength
		const frame = Buffer.allocUnsafe(3 + len)
		frame[0] = (len >>> 16) & 0xff
		frame[1] = (len >>> 8) & 0xff
		frame[2] = len & 0xff
		frame.set(data, 3)
		return frame
	}

	const encodeNode = (node: BinaryNode): Buffer => {
		if (!transport) {
			throw new Error('Cannot encode binary node before transport state is ready')
		}
		const raw = encodeBinaryNode(node)
		const enc = transport.encrypt(raw)
		return encodeFrame(enc)
	}

	return {
		processClientHello,
		feed,
		encodeNode,
		encodeFrame,
		get isTransport() {
			return transport !== null
		}
	}
}

/**
 * Feeds the very first chunk(s) received from a client through the handshake
 * pipeline. Returns the bytes to send back and a `finish` callback that must
 * be invoked once the client-finish frame has been received.
 */
export const parseFirstFrame = (raw: Buffer): { frame: Buffer; rest: Buffer } => {
	// Strip routing header if present, then NOISE_WA_HEADER, then read one
	// length-prefixed frame.
	let buf = raw
	if (buf[0] === 0x45 && buf[1] === 0x44) {
		throw new Error('Routing-info handshake header is not supported')
	}
	if (buf.length < NOISE_WA_HEADER.length) {
		throw new Error('First inbound chunk is shorter than NOISE_WA_HEADER')
	}
	for (let i = 0; i < NOISE_WA_HEADER.length; i++) {
		if (buf[i] !== NOISE_WA_HEADER[i]) {
			throw new Error('Missing NOISE_WA_HEADER on first inbound chunk')
		}
	}
	buf = buf.subarray(NOISE_WA_HEADER.length)
	if (buf.length < 3) {
		throw new Error('First inbound chunk truncated before length prefix')
	}
	const size = (buf[0]! << 16) | (buf[1]! << 8) | buf[2]!
	if (buf.length < size + 3) {
		throw new Error('First inbound chunk does not contain the full client-hello')
	}
	return { frame: buf.subarray(3, size + 3), rest: buf.subarray(size + 3) }
}

/**
 * Reads one length-prefixed frame from a buffer (used to extract the
 * client-finish frame from incoming bytes during handshake).
 */
export const parseRawFrame = (buf: Buffer): { frame: Buffer; rest: Buffer } | null => {
	if (buf.length < 3) {
		return null
	}
	const size = (buf[0]! << 16) | (buf[1]! << 8) | buf[2]!
	if (buf.length < size + 3) {
		return null
	}
	return { frame: buf.subarray(3, size + 3), rest: buf.subarray(size + 3) }
}
