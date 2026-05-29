/**
 * Standalone tests that exercise the server-side noise handler & cert chain
 * against the *real* client-side noise handler from `src/Utils/noise-handler.ts`,
 * without involving the WebSocket layer. These tests do NOT depend on
 * libsignal-backed transport code and are a good first thing to run when
 * troubleshooting.
 */
import { proto } from '../../WAProto'
import { NOISE_WA_HEADER } from '../../src/Defaults'
import { makeNoiseHandler } from '../../src/Utils/noise-handler'
import { Curve } from '../../src/Utils/crypto'
import { initAuthCreds } from '../../src/Utils/auth-utils'
import { makeServerNoise, parseFirstFrame, parseRawFrame } from '../src/server-noise'
import { installTestCerts, uninstallTestCerts } from '../src/test-cert'
import { makeTestLogger } from '../src/logger'

describe('server-noise (transport-less)', () => {
	beforeAll(() => installTestCerts())
	afterAll(() => uninstallTestCerts())

	it('completes the Noise XX handshake with a real Baileys client noise handler', async () => {
		const creds = initAuthCreds()
		const logger = makeTestLogger('noise-it', 'silent')
		const clientEph = Curve.generateKeyPair()
		const client = makeNoiseHandler({ keyPair: clientEph, NOISE_HEADER: NOISE_WA_HEADER, logger })

		// 1. Client builds clientHello and encodes its first frame.
		const clientHelloMsg = proto.HandshakeMessage.encode({
			clientHello: { ephemeral: clientEph.public }
		}).finish()
		const firstChunk = client.encodeFrame(clientHelloMsg)

		// 2. Server consumes the first chunk.
		const server = makeServerNoise()
		const serverStatic = Curve.generateKeyPair()
		const { frame: clientHelloFrame } = parseFirstFrame(Buffer.from(firstChunk))
		const { serverHelloBytes, finish } = await server.processClientHello(clientHelloFrame, serverStatic)

		// 3. Client processes the server hello.
		const serverHelloPayload = proto.HandshakeMessage.decode(serverHelloBytes)
		const keyEnc = await client.processHandshake(serverHelloPayload, creds.noiseKey)

		// 4. Client produces clientFinish.
		const clientPayloadBytes = proto.ClientPayload.encode({}).finish()
		const payloadEnc = client.encrypt(clientPayloadBytes)
		const clientFinishMsg = proto.HandshakeMessage.encode({
			clientFinish: { static: keyEnc, payload: payloadEnc }
		}).finish()
		const clientFinishFrame = client.encodeFrame(clientFinishMsg)
		await client.finishInit()

		// 5. Server completes.
		const parsed = parseRawFrame(Buffer.from(clientFinishFrame))!
		expect(parsed).not.toBeNull()
		await finish(parsed.frame)

		// 6. Round-trip a transport frame to prove keys are aligned.
		const node = { tag: 'success', attrs: { lid: '1@lid', t: '0' } } as const
		const encodedFromServer = server.encodeNode(node)

		const recv: unknown[] = []
		await client.decodeFrame(Buffer.from(encodedFromServer), f => recv.push(f))

		expect(recv.length).toBe(1)
		expect((recv[0] as { tag: string }).tag).toBe('success')
	})
})
