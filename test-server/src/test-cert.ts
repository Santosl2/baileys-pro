/**
 * test-cert.ts
 *
 * Generates a deterministic test cert-chain compatible with Baileys' client
 * noise handshake (see `src/Utils/noise-handler.ts#processHandshake`).
 *
 * IMPORTANT LIMITATION:
 *   The real WhatsApp servers sign their noise certificates with a private key
 *   that we do not have. To make Baileys clients accept our fake server we
 *   *mutate the `WA_CERT_DETAILS` constant at runtime* so the verification
 *   public key and serial belong to a key pair we control. Since
 *   `WA_CERT_DETAILS` is a single shared object exported from
 *   `src/Defaults/index.ts`, every Baileys instance running in the same Node
 *   process automatically picks up the patched value.
 *
 *   Do NOT use this module in production code paths.
 */

import { proto } from '../../WAProto'
import { WA_CERT_DETAILS } from '../../src/Defaults'
import type { KeyPair } from '../../src/Types'
import { Curve } from '../../src/Utils/crypto'

export type TestCertContext = {
	rootKeyPair: KeyPair
	intermediateKeyPair: KeyPair
	intermediateSerial: number
	originalRoot: Pick<typeof WA_CERT_DETAILS, 'SERIAL' | 'ISSUER' | 'PUBLIC_KEY'>
}

let installed: TestCertContext | null = null

/**
 * Installs a fresh test root key into the shared `WA_CERT_DETAILS` constant
 * so that any Baileys client running in this process will accept certificates
 * signed by it. Idempotent: subsequent calls return the previously installed
 * context.
 */
export const installTestCerts = (): TestCertContext => {
	if (installed) {
		return installed
	}

	const rootKeyPair = Curve.generateKeyPair()
	const intermediateKeyPair = Curve.generateKeyPair()

	const originalRoot = {
		SERIAL: WA_CERT_DETAILS.SERIAL,
		ISSUER: WA_CERT_DETAILS.ISSUER,
		PUBLIC_KEY: WA_CERT_DETAILS.PUBLIC_KEY
	}

	WA_CERT_DETAILS.SERIAL = 0
	WA_CERT_DETAILS.ISSUER = 'BaileysTestLongTerm1'
	WA_CERT_DETAILS.PUBLIC_KEY = Buffer.from(rootKeyPair.public)

	installed = {
		rootKeyPair,
		intermediateKeyPair,
		intermediateSerial: 1,
		originalRoot
	}
	return installed
}

/**
 * Restores the original (production) `WA_CERT_DETAILS` values.
 * Useful for ensuring test isolation when a Node process is reused across
 * multiple unrelated test suites.
 */
export const uninstallTestCerts = (): void => {
	if (!installed) {
		return
	}
	WA_CERT_DETAILS.SERIAL = installed.originalRoot.SERIAL
	WA_CERT_DETAILS.ISSUER = installed.originalRoot.ISSUER
	WA_CERT_DETAILS.PUBLIC_KEY = installed.originalRoot.PUBLIC_KEY
	installed = null
}

/**
 * Builds an encoded `proto.CertChain` whose leaf certifies the supplied
 * `serverStaticPublic` key. The chain layout is identical to what the
 * client expects:
 *
 *   - `intermediate.details`  is signed by the installed root key pair.
 *   - `leaf.details`          is signed by `intermediateKeyPair`.
 *   - The intermediate carries `issuerSerial == WA_CERT_DETAILS.SERIAL`.
 *
 * Returns the protobuf-encoded bytes ready to be encrypted as the
 * `serverHello.payload`.
 */
export const buildTestCertChainBytes = (serverStaticPublic: Uint8Array): Uint8Array => {
	const ctx = installTestCerts()

	const intermediateDetails = proto.CertChain.NoiseCertificate.Details.encode({
		serial: ctx.intermediateSerial,
		issuerSerial: WA_CERT_DETAILS.SERIAL,
		key: ctx.intermediateKeyPair.public,
		notBefore: 0,
		notAfter: 0
	}).finish()
	const intermediateSignature = Curve.sign(ctx.rootKeyPair.private, intermediateDetails)

	const leafDetails = proto.CertChain.NoiseCertificate.Details.encode({
		serial: 2,
		issuerSerial: ctx.intermediateSerial,
		key: Buffer.from(serverStaticPublic),
		notBefore: 0,
		notAfter: 0
	}).finish()
	const leafSignature = Curve.sign(ctx.intermediateKeyPair.private, leafDetails)

	return proto.CertChain.encode({
		intermediate: { details: intermediateDetails, signature: intermediateSignature },
		leaf: { details: leafDetails, signature: leafSignature }
	}).finish()
}
