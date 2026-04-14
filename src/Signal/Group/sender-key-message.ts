import { calculateSignature, verifySignature } from 'libsignal/src/curve'
import { proto } from '../../../WAProto'
import { CiphertextMessage } from './ciphertext-message'

interface SenderKeyMessageStructure {
	id: number
	iteration: number
	ciphertext: string | Buffer
}

export class SenderKeyMessage extends CiphertextMessage {
	private readonly SIGNATURE_LENGTH = 64
	private readonly messageVersion: number
	private readonly keyId: number
	private readonly iteration: number
	private readonly ciphertext: Uint8Array
	private readonly signature: Uint8Array
	private readonly serialized: Uint8Array

	constructor(serialized: Uint8Array) {
		super()
		const version = serialized[0]
		const message = serialized.slice(1, serialized.length - this.SIGNATURE_LENGTH)
		const signature = serialized.slice(-1 * this.SIGNATURE_LENGTH)
		const senderKeyMessage = proto.SenderKeyMessage.decode(message).toJSON() as SenderKeyMessageStructure

		this.serialized = serialized
		this.messageVersion = (version & 0xff) >> 4
		this.keyId = senderKeyMessage.id
		this.iteration = senderKeyMessage.iteration
		this.ciphertext =
			typeof senderKeyMessage.ciphertext === 'string'
				? Buffer.from(senderKeyMessage.ciphertext, 'base64')
				: senderKeyMessage.ciphertext
		this.signature = signature
	}

	/** Async factory for creating a signed outgoing SenderKeyMessage */
	public static async create(
		keyId: number,
		iteration: number,
		ciphertext: Uint8Array,
		signatureKey: Uint8Array
	): Promise<SenderKeyMessage> {
		const CURRENT_VERSION = 3
		const version = (((CURRENT_VERSION << 4) | CURRENT_VERSION) & 0xff) % 256
		const ciphertextBuffer = Buffer.from(ciphertext)
		const message = proto.SenderKeyMessage.encode(
			proto.SenderKeyMessage.create({ id: keyId, iteration, ciphertext: ciphertextBuffer })
		).finish()

		const signature = Buffer.from(
			await calculateSignature(signatureKey, Buffer.concat([Buffer.from([version]), message]))
		)
		const serialized = Buffer.concat([Buffer.from([version]), message, signature])
		return new SenderKeyMessage(serialized)
	}

	public getKeyId(): number {
		return this.keyId
	}

	public getIteration(): number {
		return this.iteration
	}

	public getCipherText(): Uint8Array {
		return this.ciphertext
	}

	public async verifySignature(signatureKey: Uint8Array): Promise<void> {
		const part1 = this.serialized.slice(0, this.serialized.length - this.SIGNATURE_LENGTH)
		const part2 = this.serialized.slice(-1 * this.SIGNATURE_LENGTH)
		const res = await verifySignature(signatureKey, part1, part2)
		if (!res) {
			console.log({ signatureKey, part1, part2, serialized: this.serialized }, 'Invalid signature!')
			throw new Error('Invalid signature!')
		}
	}

	public serialize(): Uint8Array {
		return this.serialized
	}

	public getType(): number {
		return 4
	}
}
