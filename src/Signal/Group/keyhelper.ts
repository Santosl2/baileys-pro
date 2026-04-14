import * as nodeCrypto from 'crypto'
import { generateKeyPair } from 'libsignal/src/curve'

export function generateSenderKey(): Buffer {
	return nodeCrypto.randomBytes(32)
}

export function generateSenderKeyId(): number {
	return nodeCrypto.randomInt(2147483647)
}

export interface SigningKeyPair {
	public: Buffer
	private: Buffer
}

export async function generateSenderSigningKey(): Promise<SigningKeyPair> {
	const resolved = await generateKeyPair()

	return {
		public: Buffer.from(resolved.pubKey),
		private: Buffer.from(resolved.privKey)
	}
}
