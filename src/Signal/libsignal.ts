import type { SignalStorage } from 'whatsapp-rust-bridge'
import {
	GroupCipher,
	GroupSessionBuilder,
	hasLogger,
	ProtocolAddress,
	SenderKeyDistributionMessage,
	SenderKeyName,
	SessionBuilder,
	SessionCipher,
	SessionRecord,
	setLogger
} from 'whatsapp-rust-bridge'
import { proto } from '../../WAProto/index.js'
import type { SignalAuthState, SignalKeyStoreWithTransaction, SignalRepository } from '../Types'
import type { ILogger } from '../Utils/logger'
import { makeKeyedMutex } from '../Utils/make-mutex'
import { jidDecode, WAJIDDomains } from '../WABinary'

/** Extract identity key from PreKeyWhisperMessage for identity change detection */
function extractIdentityFromPkmsg(ciphertext: Uint8Array): Uint8Array | undefined {
	try {
		if (!ciphertext || ciphertext.length < 2) {
			return undefined
		}

		// Version byte check (version 3)
		const version = ciphertext[0]!
		if ((version & 0xf) !== 3) {
			return undefined
		}

		// Parse protobuf (skip version byte)
		const preKeyProto = proto.PreKeySignalMessage.decode(ciphertext.slice(1))
		if (preKeyProto.identityKey?.length === 33) {
			return new Uint8Array(preKeyProto.identityKey)
		}

		return undefined
	} catch {
		return undefined
	}
}

export function makeLibSignalRepository(auth: SignalAuthState, logger: ILogger): SignalRepository {
	if (!hasLogger()) {
		setLogger(logger)
	}

	const storage = signalStorage(auth)
	const parsedKeys = auth.keys as SignalKeyStoreWithTransaction

	// Mutex por endereço de sessão (1-to-1) e por grupo (group messages).
	// Impede que encrypt/decrypt/inject concorrentes para o mesmo par
	// JID ou grupo corram em paralelo e corrompam o estado da sessão.
	const sessionMutex = makeKeyedMutex()

	// Sorted to prevent deadlocks between callers asking for overlapping sets.
	const withSessionLocks = async <T>(keys: string[], work: () => Promise<T>): Promise<T> => {
		const sorted = Array.from(new Set(keys)).sort()
		const acquire = async (idx: number): Promise<T> => {
			if (idx >= sorted.length) return work()
			return sessionMutex.mutex(sorted[idx]!, () => acquire(idx + 1))
		}

		return acquire(0)
	}

	const repository: SignalRepository = {
		decryptGroupMessage({ group, authorJid, msg }) {
			const senderAddr = jidToSignalProtocolAddress(authorJid)
			const cipher = new GroupCipher(storage, group, senderAddr)

			return withSessionLocks([group], () =>
				parsedKeys.transaction(async () => {
					return cipher.decrypt(msg)
				}, group)
			)
		},

		async processSenderKeyDistributionMessage({ item, authorJid }) {
			const builder = new GroupSessionBuilder(storage)
			if (!item.groupId) {
				throw new Error('Group ID is required for sender key distribution message')
			}

			const senderAddr = jidToSignalProtocolAddress(authorJid)
			const senderName = new SenderKeyName(item.groupId, senderAddr)
			const senderMsg = SenderKeyDistributionMessage.deserialize(item.axolotlSenderKeyDistributionMessage!)

			return withSessionLocks([item.groupId], () =>
				parsedKeys.transaction(async () => {
					await builder.process(senderName, senderMsg)
				}, item.groupId)
			)
		},

		async decryptMessage({ jid, type, ciphertext }) {
			const addr = jidToSignalProtocolAddress(jid)
			const addrStr = addr.toString()
			const session = new SessionCipher(storage, addr)

			return withSessionLocks([addrStr], () =>
				parsedKeys.transaction(async () => {
					if (type === 'pkmsg') {
						const identityKey = extractIdentityFromPkmsg(ciphertext)
						if (identityKey) {
							const identityChanged = await storage.saveIdentity(addrStr, identityKey)
							if (identityChanged) {
								logger.info(
									{ jid, addr: addrStr },
									'identity key changed or new contact, session will be re-established'
								)
							}
						}
					}

					switch (type) {
						case 'pkmsg':
							return session.decryptPreKeyWhisperMessage(ciphertext)
						case 'msg':
							return session.decryptWhisperMessage(ciphertext)
					}
				}, addrStr)
			)
		},

		async encryptMessage({ jid, data }) {
			const addr = jidToSignalProtocolAddress(jid)
			const addrStr = addr.toString()
			const cipher = new SessionCipher(storage, addr)

			return withSessionLocks([addrStr], () =>
				parsedKeys.transaction(async () => {
					try {
						const { type: sigType, body } = await cipher.encrypt(data)
						const type = (sigType === 3 ? 'pkmsg' : 'msg') as 'msg' | 'pkmsg'
						return { type, ciphertext: body }
					} catch (error) {
						logger.info(`Encryption failed ${error}`)
						throw error
					}
				}, addrStr)
			)
		},

		async encryptGroupMessage({ group, meId, data }) {
			const builder = new GroupSessionBuilder(storage)
			const meAddr = jidToSignalProtocolAddress(meId)
			const senderName = jidToSignalSenderKeyName(group, meId)
			const cipher = new GroupCipher(storage, group, meAddr)

			return withSessionLocks([group], () =>
				parsedKeys.transaction(async () => {
					try {
						const senderKeyDistributionMessage = await builder.create(senderName)
						const ciphertext = await cipher.encrypt(data)
						return {
							ciphertext,
							senderKeyDistributionMessage: senderKeyDistributionMessage.serialize()
						}
					} catch (error) {
						logger.info(`Group message encryption failed ${error}`)
						throw error
					}
				}, group)
			)
		},

		// hasSenderKey é uma leitura informativa (usada para decidir se precisa
		// redistribuir a sender key). Uma leitura levemente stale é aceitável
		// aqui — forçar mutex aumentaria contenção sem ganho real de correção,
		// pois o caller deve tolerar falsos negativos.
		async hasSenderKey({ group, meId }) {
			const senderName = jidToSignalSenderKeyName(group, meId).toString()
			const { [senderName]: key } = await auth.keys.get('sender-key', [senderName])
			return !!key
		},

		async createSenderKeyDistributionMessage({ group, meId }) {
			const builder = new GroupSessionBuilder(storage)
			const senderName = jidToSignalSenderKeyName(group, meId)

			return withSessionLocks([group], () =>
				parsedKeys.transaction(async () => {
					const skdm = await builder.create(senderName)
					return skdm.serialize()
				}, group)
			)
		},

		async injectE2ESession({ jid, session }) {
			logger.trace({ jid }, 'injecting E2EE session')
			const addr = jidToSignalProtocolAddress(jid)
			const addrStr = addr.toString()
			const cipher = new SessionBuilder(storage, addr)

			return withSessionLocks([addrStr], () =>
				parsedKeys.transaction(async () => {
					await cipher.initOutgoing(session)
				}, addrStr)
			)
		},

		jidToSignalProtocolAddress(jid) {
			return jidToSignalProtocolAddress(jid).toString()
		},

		async validateSession(jid: string) {
			try {
				const addr = jidToSignalProtocolAddress(jid)
				const sessionData = await storage.loadSession(addr.toString())

				if (!sessionData) {
					return { exists: false, reason: 'no session' }
				}

				const record = SessionRecord.deserialize(sessionData)
				if (!record.haveOpenSession()) {
					return { exists: false, reason: 'no open session' }
				}

				return { exists: true }
			} catch (error) {
				return { exists: false, reason: 'validation error' }
			}
		},

		async deleteSession(...jids: string[]) {
			if (!jids.length) return

			const sessionKeys = jids.map(jid => jidToSignalProtocolAddress(jid).toString())
			const sessionUpdates = Object.fromEntries(sessionKeys.map(k => [k, null])) as {
				[key: string]: null
			}

			return withSessionLocks(sessionKeys, () => auth.keys.set({ session: sessionUpdates }))
		}
	}

	return repository
}

export const jidToSignalProtocolAddress = (jid: string): ProtocolAddress => {
	const decoded = jidDecode(jid)!
	const { user, device, server, domainType } = decoded

	if (!user) {
		throw new Error(
			`JID decoded but user is empty: "${jid}" -> user: "${user}", server: "${server}", device: ${device}`
		)
	}

	const signalUser = domainType !== WAJIDDomains.WHATSAPP ? `${user}_${domainType}` : user
	const finalDevice = device || 0

	// if (device === 99 && decoded.server !== 'hosted' && decoded.server !== 'hosted.lid') {
	// 	throw new Error('Unexpected non-hosted device JID with device 99. This ID seems invalid. ID:' + jid)
	// }

	return new ProtocolAddress(signalUser, finalDevice)
}

const jidToSignalSenderKeyName = (group: string, user: string): SenderKeyName => {
	return new SenderKeyName(group, jidToSignalProtocolAddress(user))
}

function signalStorage({ creds, keys }: SignalAuthState): SignalStorage & {
	loadIdentityKey(id: string): Promise<Uint8Array | undefined>
	saveIdentity(id: string, identityKey: Uint8Array): Promise<boolean>
} {
	return {
		loadSession: async (id: string) => {
			try {
				const { [id]: sess } = await keys.get('session', [id])
				if (sess) {
					return sess
				}

				return null
			} catch (e) {
				return null
			}
		},
		storeSession: async (id: string, session: SessionRecord) => {
			const serialized = session.serialize()
			await keys.set({ session: { [id]: serialized } })
		},
		isTrustedIdentity: () => {
			return true // TOFU - Trust on First Use (same as WhatsApp Web)
		},
		loadIdentityKey: async (id: string) => {
			const { [id]: key } = await keys.get('identity-key', [id])
			return key || undefined
		},
		saveIdentity: async (id: string, identityKey: Uint8Array): Promise<boolean> => {
			const { [id]: existingKey } = await keys.get('identity-key', [id])

			const keysMatch =
				existingKey &&
				existingKey.length === identityKey.length &&
				existingKey.every((byte, i) => byte === identityKey[i])

			if (existingKey && !keysMatch) {
				// Identity changed - clear session and update key
				await keys.set({
					session: { [id]: null },
					'identity-key': { [id]: identityKey }
				})
				return true
			}

			if (!existingKey) {
				// New contact - Trust on First Use (TOFU)
				await keys.set({ 'identity-key': { [id]: identityKey } })
				return true
			}

			return false
		},
		loadPreKey: async (id: number) => {
			const keyId = id.toString()
			const { [keyId]: key } = await keys.get('pre-key', [keyId])
			if (key) {
				return {
					privKey: key.private,
					pubKey: key.public
				}
			}
		},
		removePreKey: (id: number) => keys.set({ 'pre-key': { [id]: null } }),
		loadSignedPreKey: async (id: number) => {
			const key = creds.signedPreKey
			if (!key || key.keyId !== id) {
				return null
			}

			return {
				keyId: key.keyId,
				signature: key.signature,
				keyPair: {
					pubKey: key.keyPair.public,
					privKey: key.keyPair.private
				}
			}
		},
		loadSenderKey: async (keyId: string) => {
			const { [keyId]: key } = await keys.get('sender-key', [keyId])
			return key ?? null
		},
		storeSenderKey: async (keyId: string, keyBytes: Uint8Array) => {
			await keys.set({ 'sender-key': { [keyId]: keyBytes.slice() } })
		},
		getOurRegistrationId: () => creds.registrationId,
		getOurIdentity: () => {
			const { signedIdentityKey } = creds
			return {
				privKey: signedIdentityKey.private,
				pubKey: signedIdentityKey.public
			}
		}
	}
}
