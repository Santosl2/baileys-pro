import * as libsignal from 'libsignal'
import { createHash, webcrypto } from 'node:crypto'
import { KEY_BUNDLE_TYPE } from '../Defaults'
import { KeyPair } from '../Types'

// insure browser & node compatibility
const { subtle } = webcrypto

/** Copy data into a plain ArrayBuffer required by the WebCrypto API */
const toArrayBuffer = (data: Uint8Array | Buffer): ArrayBuffer => {
	const copy = new ArrayBuffer(data.byteLength)
	new Uint8Array(copy).set(data)
	return copy
}

/** prefix version byte to the pub keys, required for some curve crypto functions */
export const generateSignalPubKey = (pubKey: Uint8Array | Buffer) =>
	pubKey.length === 33 ? pubKey : Buffer.concat([KEY_BUNDLE_TYPE, pubKey])

export const Curve = {
	generateKeyPair: (): KeyPair => {
		const { pubKey, privKey } = libsignal.curve.generateKeyPair()
		return {
			private: Buffer.from(privKey),
			// remove version byte
			public: Buffer.from((pubKey as Uint8Array).slice(1))
		}
	},
	sharedKey: (privateKey: Uint8Array, publicKey: Uint8Array) => {
		const shared = libsignal.curve.calculateAgreement(generateSignalPubKey(publicKey), privateKey)
		return Buffer.from(shared)
	},
	sign: (privateKey: Uint8Array, buf: Uint8Array) => libsignal.curve.calculateSignature(privateKey, buf),
	verify: (pubKey: Uint8Array, message: Uint8Array, signature: Uint8Array) => {
		try {
			libsignal.curve.verifySignature(generateSignalPubKey(pubKey), message, signature)
			return true
		} catch (error) {
			return false
		}
	}
}

export const signedKeyPair = (identityKeyPair: KeyPair, keyId: number) => {
	const preKey = Curve.generateKeyPair()
	const pubKey = generateSignalPubKey(preKey.public)

	const signature = Curve.sign(identityKeyPair.private, pubKey)

	return { keyPair: preKey, signature, keyId }
}

/**
 * encrypt AES 256 GCM;
 * where the tag is suffixed to the ciphertext
 * */
export async function aesEncryptGCM(
	plaintext: Uint8Array,
	key: Uint8Array,
	iv: Uint8Array,
	additionalData: Uint8Array
): Promise<Buffer> {
	const cryptoKey = await subtle.importKey('raw', toArrayBuffer(key), { name: 'AES-GCM' }, false, ['encrypt'])
	const encrypted = await subtle.encrypt(
		{ name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(additionalData), tagLength: 128 },
		cryptoKey,
		toArrayBuffer(plaintext)
	)
	return Buffer.from(encrypted)
}

/**
 * decrypt AES 256 GCM;
 * where the auth tag is suffixed to the ciphertext
 * */
export async function aesDecryptGCM(
	ciphertext: Uint8Array,
	key: Uint8Array,
	iv: Uint8Array,
	additionalData: Uint8Array
): Promise<Buffer> {
	const cryptoKey = await subtle.importKey('raw', toArrayBuffer(key), { name: 'AES-GCM' }, false, ['decrypt'])
	const decrypted = await subtle.decrypt(
		{ name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(additionalData), tagLength: 128 },
		cryptoKey,
		toArrayBuffer(ciphertext)
	)
	return Buffer.from(decrypted)
}

export async function aesEncryptCTR(plaintext: Uint8Array, key: Uint8Array, iv: Uint8Array): Promise<Buffer> {
	const cryptoKey = await subtle.importKey('raw', toArrayBuffer(key), { name: 'AES-CTR' }, false, ['encrypt'])
	const encrypted = await subtle.encrypt(
		{ name: 'AES-CTR', counter: toArrayBuffer(iv), length: 128 },
		cryptoKey,
		toArrayBuffer(plaintext)
	)
	return Buffer.from(encrypted)
}

export async function aesDecryptCTR(ciphertext: Uint8Array, key: Uint8Array, iv: Uint8Array): Promise<Buffer> {
	const cryptoKey = await subtle.importKey('raw', toArrayBuffer(key), { name: 'AES-CTR' }, false, ['decrypt'])
	const decrypted = await subtle.decrypt(
		{ name: 'AES-CTR', counter: toArrayBuffer(iv), length: 128 },
		cryptoKey,
		toArrayBuffer(ciphertext)
	)
	return Buffer.from(decrypted)
}

/** decrypt AES 256 CBC; where the IV is prefixed to the buffer */
export async function aesDecrypt(buffer: Buffer, key: Buffer): Promise<Buffer> {
	return await aesDecryptWithIV(buffer.slice(16, buffer.length), key, buffer.slice(0, 16))
}

/** decrypt AES 256 CBC */
export async function aesDecryptWithIV(buffer: Buffer, key: Buffer, IV: Buffer): Promise<Buffer> {
	const cryptoKey = await subtle.importKey('raw', toArrayBuffer(key), { name: 'AES-CBC' }, false, ['decrypt'])
	const decrypted = await subtle.decrypt({ name: 'AES-CBC', iv: toArrayBuffer(IV) }, cryptoKey, toArrayBuffer(buffer))
	return Buffer.from(decrypted)
}

// encrypt AES 256 CBC; where a random IV is prefixed to the buffer
export async function aesEncrypt(buffer: Buffer | Uint8Array, key: Buffer): Promise<Buffer> {
	const IV = globalThis.crypto.getRandomValues(new Uint8Array(16))
	const cryptoKey = await subtle.importKey('raw', toArrayBuffer(key), { name: 'AES-CBC' }, false, ['encrypt'])
	const encrypted = await subtle.encrypt({ name: 'AES-CBC', iv: IV.buffer }, cryptoKey, toArrayBuffer(buffer))
	return Buffer.concat([Buffer.from(IV), Buffer.from(encrypted)]) // prefix IV to the buffer
}

// encrypt AES 256 CBC with a given IV
export async function aesEncrypWithIV(buffer: Buffer, key: Buffer, IV: Buffer): Promise<Buffer> {
	const cryptoKey = await subtle.importKey('raw', toArrayBuffer(key), { name: 'AES-CBC' }, false, ['encrypt'])
	const encrypted = await subtle.encrypt({ name: 'AES-CBC', iv: toArrayBuffer(IV) }, cryptoKey, toArrayBuffer(buffer))
	return Buffer.from(encrypted)
}

// sign HMAC using SHA 256
export async function hmacSign(
	buffer: Buffer | Uint8Array,
	key: Buffer | Uint8Array,
	variant: 'sha256' | 'sha512' = 'sha256'
): Promise<Buffer> {
	const hashAlgo = variant === 'sha256' ? 'SHA-256' : 'SHA-512'
	const cryptoKey = await subtle.importKey('raw', toArrayBuffer(key), { name: 'HMAC', hash: hashAlgo }, false, ['sign'])
	const signature = await subtle.sign('HMAC', cryptoKey, toArrayBuffer(buffer))
	return Buffer.from(signature)
}

export async function sha256(buffer: Buffer): Promise<Buffer> {
	const hash = await subtle.digest('SHA-256', toArrayBuffer(buffer))
	return Buffer.from(hash)
}

// MD5 is not supported by the WebCrypto API
export function md5(buffer: Buffer): Buffer {
	return createHash('md5').update(buffer).digest()
}

// HKDF key expansion
export async function hkdf(
	buffer: Uint8Array | Buffer,
	expandedLength: number,
	info: { salt?: Buffer; info?: string }
): Promise<Buffer> {
	const salt = info.salt ? toArrayBuffer(info.salt) : new ArrayBuffer(0)
	const infoBytes = info.info ? new TextEncoder().encode(info.info) : new Uint8Array(0)

	const importedKey = await subtle.importKey('raw', toArrayBuffer(buffer), { name: 'HKDF' }, false, ['deriveBits'])

	const derivedBits = await subtle.deriveBits(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt,
			info: infoBytes
		},
		importedKey,
		expandedLength * 8 // Convert bytes to bits
	)

	return Buffer.from(derivedBits)
}

export async function derivePairingCodeKey(pairingCode: string, salt: Buffer): Promise<Buffer> {
	const pairingCodeBuffer = new TextEncoder().encode(pairingCode)
	const saltBuffer = toArrayBuffer(salt)

	const keyMaterial = await subtle.importKey('raw', pairingCodeBuffer.buffer, { name: 'PBKDF2' }, false, ['deriveBits'])

	// 2 << 16 = 131,072 iterations
	const derivedBits = await subtle.deriveBits(
		{
			name: 'PBKDF2',
			salt: saltBuffer,
			iterations: 2 << 16,
			hash: 'SHA-256'
		},
		keyMaterial,
		32 * 8 // 32 bytes * 8 = 256 bits
	)

	return Buffer.from(derivedBits)
}
