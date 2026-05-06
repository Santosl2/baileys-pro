declare module 'libsignal/src/crypto' {
	export function encrypt(key: Uint8Array, data: Uint8Array, iv?: Uint8Array): Uint8Array
	export function decrypt(key: Uint8Array, data: Uint8Array, iv?: Uint8Array): Uint8Array
	export function calculateMAC(key: Uint8Array, data: Uint8Array): Uint8Array
	export function deriveSecrets(
		input: Uint8Array,
		salt: Uint8Array,
		info: Uint8Array,
		chunks?: number
	): Uint8Array[]
}

declare module 'libsignal/src/curve' {
	export interface KeyPair {
		pubKey: Uint8Array
		privKey: Uint8Array
	}
	export function generateKeyPair(): KeyPair
	export function calculateAgreement(pubKey: Uint8Array, privKey: Uint8Array): Uint8Array
	export function calculateSignature(privKey: Uint8Array, message: Uint8Array): Uint8Array
	export function verifySignature(pubKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean
}
