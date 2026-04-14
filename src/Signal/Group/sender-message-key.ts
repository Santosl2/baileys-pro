import { deriveSecrets } from 'libsignal/src/crypto'

export class SenderMessageKey {
	private readonly iteration: number
	private readonly iv: Uint8Array
	private readonly cipherKey: Uint8Array
	private readonly seed: Uint8Array

	private constructor(iteration: number, seed: Uint8Array, iv: Uint8Array, cipherKey: Uint8Array) {
		this.iteration = iteration
		this.seed = seed
		this.iv = iv
		this.cipherKey = cipherKey
	}

	public static async create(iteration: number, seed: Uint8Array): Promise<SenderMessageKey> {
		const derivative = await deriveSecrets(seed, Buffer.alloc(32), Buffer.from('WhisperGroup'))
		const keys = new Uint8Array(32)
		keys.set(new Uint8Array(derivative[0].slice(16)))
		keys.set(new Uint8Array(derivative[1].slice(0, 16)), 16)

		const iv = Buffer.from(derivative[0].slice(0, 16))
		const cipherKey = Buffer.from(keys.buffer)
		return new SenderMessageKey(iteration, seed, iv, cipherKey)
	}

	public getIteration(): number {
		return this.iteration
	}

	public getIv(): Uint8Array {
		return this.iv
	}

	public getCipherKey(): Uint8Array {
		return this.cipherKey
	}

	public getSeed(): Uint8Array {
		return this.seed
	}
}
