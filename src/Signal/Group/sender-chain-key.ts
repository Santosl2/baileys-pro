import { calculateMAC } from 'libsignal/src/crypto'
import { SenderMessageKey } from './sender-message-key'

export class SenderChainKey {
	private readonly MESSAGE_KEY_SEED: Uint8Array = Buffer.from([0x01])
	private readonly CHAIN_KEY_SEED: Uint8Array = Buffer.from([0x02])
	private readonly iteration: number
	private readonly chainKey: Buffer

	constructor(iteration: number, chainKey: any) {
		this.iteration = iteration
		if (Buffer.isBuffer(chainKey)) {
			this.chainKey = chainKey
		} else if (chainKey instanceof Uint8Array) {
			this.chainKey = Buffer.from(chainKey)
		} else if (chainKey && typeof chainKey === 'object') {
			//@ts-expect-error
			this.chainKey = Buffer.from(Object.values(chainKey))
		} else {
			this.chainKey = Buffer.from(chainKey || [])
		}
	}

	public getIteration(): number {
		return this.iteration
	}

	public getSenderMessageKey(): Promise<SenderMessageKey> {
		return this.getDerivative(this.MESSAGE_KEY_SEED, this.chainKey).then(seed =>
			SenderMessageKey.create(this.iteration, seed)
		)
	}

	public async getNext(): Promise<SenderChainKey> {
		return new SenderChainKey(this.iteration + 1, await this.getDerivative(this.CHAIN_KEY_SEED, this.chainKey))
	}

	public getSeed(): Uint8Array {
		return this.chainKey
	}

	private async getDerivative(seed: Uint8Array, key: Buffer): Promise<Uint8Array> {
		return calculateMAC(key, seed)
	}
}
