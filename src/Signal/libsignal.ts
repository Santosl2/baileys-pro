import * as libsignal from 'libsignal'
import { PreKeyWhisperMessage } from 'libsignal/src/protobufs'
import { SignalAuthState, SignalKeyStoreWithTransaction } from '../Types'
import { SignalRepository } from '../Types/Signal'
import { generateSignalPubKey } from '../Utils'
import logger from '../Utils/logger'
// FIX 1: import do mutex utilitário (já existe no projeto)
import { makeKeyedMutex } from '../Utils/make-mutex'
import { jidDecode } from '../WABinary'
import type { SenderKeyStore } from './Group/group_cipher'
import { SenderKeyName } from './Group/sender-key-name'
import { SenderKeyRecord } from './Group/sender-key-record'
import { GroupCipher, GroupSessionBuilder, SenderKeyDistributionMessage } from './Group'
import { LIDMappingStore } from './lid'

function extractIdentityFromPkmsg(ciphertext: Uint8Array): Uint8Array | undefined {
	try {
		if (!ciphertext || ciphertext.length < 2) {
			return undefined
		}

		// Version byte check (version 3)
		const version = ciphertext[0]
		if ((version & 0xf) !== 3) {
			return undefined
		}

		// Parse protobuf (skip version byte)
		const preKeyProto = PreKeyWhisperMessage.decode(ciphertext.slice(1))
		if (preKeyProto.identityKey?.length === 33) {
			return new Uint8Array(preKeyProto.identityKey)
		}

		return undefined
	} catch {
		return undefined
	}
}

export function makeLibSignalRepository(auth: SignalAuthState): SignalRepository {
	const lidMapping = new LIDMappingStore(auth.keys as SignalKeyStoreWithTransaction, logger)
	const storage: SenderKeyStore = signalStorage(auth)

	// FIX 2: mutex por endereço de sessão — impede que encrypt/decrypt
	// concorrentes para o mesmo par JID corram em paralelo.
	const sessionMutex = makeKeyedMutex()

	return {
		lidMapping,
		async validateSession(jid: string) {
			try {
				const addr = jidToSignalProtocolAddress(jid)
				const session = await storage.loadSession(addr.toString())

				if (!session) {
					return { exists: false, reason: 'no session' }
				}

				if (!session.haveOpenSession()) {
					return { exists: false, reason: 'no open session' }
				}

				return { exists: true }
			} catch (error) {
				return { exists: false, reason: 'validation error' }
			}
		},

		// FIX 3: deleteSession agora passa pelo mutex para não colidir com um
		// decrypt/encrypt em andamento na mesma sessão.
		deleteSession(jid: string) {
			const addr = jidToSignalProtocolAddress(jid)
			const sessionKey = addr.toString()
			return sessionMutex.mutex(sessionKey, () =>
				(auth.keys as SignalKeyStoreWithTransaction).transaction(async () => {
					await storage.deleteSession(sessionKey)
				}, sessionKey)
			)
		},

		decryptGroupMessage({ group, authorJid, msg }) {
			const senderName = jidToSignalSenderKeyName(group, authorJid)
			const cipher = new GroupCipher(storage, senderName)

			// FIX 4: chave da transaction agora é senderNameStr (igual ao
			// processSenderKeyDistributionMessage), garantindo exclusão mútua
			// entre as duas operações sobre o mesmo sender key.
			return (auth.keys as SignalKeyStoreWithTransaction).transaction(async () => {
				return cipher.decrypt(msg)
			}, senderName.toString())
		},

		async processSenderKeyDistributionMessage({ item, authorJid }) {
			const builder = new GroupSessionBuilder(storage)
			if (!item.groupId) {
				throw new Error('Group ID is required for sender key distribution message')
			}

			const senderName = jidToSignalSenderKeyName(item.groupId, authorJid)

			const senderMsg = new SenderKeyDistributionMessage(
				null,
				null,
				null,
				null,
				item.axolotlSenderKeyDistributionMessage
			)
			const senderNameStr = senderName.toString()

			// chave já era senderNameStr — mantida; agora consistente com decryptGroupMessage
			return (auth.keys as SignalKeyStoreWithTransaction).transaction(async () => {
				const { [senderNameStr]: senderKey } = await auth.keys.get('sender-key', [senderNameStr])
				if (!senderKey) {
					await storage.storeSenderKey(senderName, new SenderKeyRecord())
				}

				await builder.process(senderName, senderMsg)
			}, senderNameStr)
		},

		async decryptMessage({ jid, type, ciphertext }) {
			const addr = jidToSignalProtocolAddress(jid)
			const addrStr = addr.toString()
			const session = new libsignal.SessionCipher(storage, addr)

			// FIX 5: sessionMutex + transaction com a mesma chave (addrStr).
			// saveIdentity pode deletar a sessão — precisa estar sob o mesmo
			// lock que o decrypt para ser atômico.
			return sessionMutex.mutex(addrStr, () =>
				(auth.keys as SignalKeyStoreWithTransaction).transaction(async () => {
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
			const cipher = new libsignal.SessionCipher(storage, addr)

			// FIX 6: mesmo sessionMutex + mesma chave addrStr usada no decrypt,
			// garantindo exclusão mútua entre encrypt e decrypt da mesma sessão.
			return sessionMutex.mutex(addrStr, () =>
				(auth.keys as SignalKeyStoreWithTransaction).transaction(async () => {
					try {
						const { type: sigType, body } = await cipher.encrypt(data)
						const type = sigType === 3 ? 'pkmsg' : 'msg'
						return { type, ciphertext: Buffer.from(body, 'binary') }
					} catch (error) {
						logger.info(`Encryption failed ${error}`)
						throw error
					}
				}, addrStr)
			)
		},

		async encryptGroupMessage({ group, meId, data }) {
			const senderName = jidToSignalSenderKeyName(group, meId)
			const senderNameStr = senderName.toString()

			// FIX 7: estava completamente sem proteção — leitura, escrita e
			// cifração corriam sem transaction, permitindo que duas chamadas
			// simultâneas criassem sender keys duplicadas ou cifrassem com
			// estados inconsistentes.
			return (auth.keys as SignalKeyStoreWithTransaction).transaction(async () => {
				const { [senderNameStr]: senderKey } = await auth.keys.get('sender-key', [senderNameStr])
				if (!senderKey) {
					await storage.storeSenderKey(senderName, new SenderKeyRecord())
				}

				const builder = new GroupSessionBuilder(storage)
				const senderKeyDistributionMessage = await builder.create(senderName)
				const session = new GroupCipher(storage, senderName)
				const ciphertext = await session.encrypt(data)

				return {
					ciphertext,
					senderKeyDistributionMessage: senderKeyDistributionMessage.serialize()
				}
			}, senderNameStr)
		},

		async hasSenderKey({ group, meId }) {
			const senderName = jidToSignalSenderKeyName(group, meId).toString()
			const { [senderName]: key } = await auth.keys.get('sender-key', [senderName])
			return !!key
		},

		async createSenderKeyDistributionMessage({ group, meId }) {
			const senderName = jidToSignalSenderKeyName(group, meId)
			const builder = new GroupSessionBuilder(storage)
			const senderNameStr = senderName.toString()

			return (auth.keys as SignalKeyStoreWithTransaction).transaction(async () => {
				const { [senderNameStr]: senderKey } = await auth.keys.get('sender-key', [senderNameStr])
				if (!senderKey) {
					await storage.storeSenderKey(senderName, new SenderKeyRecord())
				}

				const skdm = await builder.create(senderName)
				return skdm.serialize()
			}, senderNameStr)
		},

		async injectE2ESession({ jid, session }) {
			const addr = jidToSignalProtocolAddress(jid)
			const addrStr = addr.toString()
			const cipher = new libsignal.SessionBuilder(storage, addr)

			// FIX 8: passa pelo sessionMutex para não colidir com um decrypt/encrypt
			// em andamento (initOutgoing escreve a sessão).
			return sessionMutex.mutex(addrStr, () =>
				(auth.keys as SignalKeyStoreWithTransaction).transaction(async () => {
					await cipher.initOutgoing(session)
				}, addrStr)
			)
		},

		jidToSignalProtocolAddress(jid) {
			return jidToSignalProtocolAddress(jid).toString()
		}
	}
}

export const jidToSignalProtocolAddress = (jid: string) => {
	const { user, device } = jidDecode(jid)!
	return new libsignal.ProtocolAddress(user, device || 0)
}

const jidToSignalSenderKeyName = (group: string, user: string): SenderKeyName => {
	return new SenderKeyName(group, jidToSignalProtocolAddress(user))
}

function signalStorage({ creds, keys }: SignalAuthState): SenderKeyStore & Record<string, any> {
	return {
		loadIdentityKey: async (id: string) => {
			const wireJid = id
			const { [wireJid]: key } = await keys.get('identity-key', [wireJid])
			return key || undefined
		},
		saveIdentity: async (id: string, identityKey: Uint8Array): Promise<boolean> => {
			const wireJid = id
			const { [wireJid]: existingKey } = await keys.get('identity-key', [wireJid])

			const keysMatch =
				existingKey &&
				existingKey.length === identityKey.length &&
				existingKey.every((byte, i) => byte === identityKey[i])

			if (existingKey && !keysMatch) {
				// Identity changed - clear session and update key
				await keys.set({
					session: { [wireJid]: null },
					'identity-key': { [wireJid]: identityKey }
				})

				return true
			}

			if (!existingKey) {
				// New contact - Trust on First Use (TOFU)
				await keys.set({ 'identity-key': { [wireJid]: identityKey } })
				return true
			}

			return false
		},
		deleteSession: async (id: string) => {
			await keys.set({ session: { [id]: null } })
		},
		loadSession: async (id: string) => {
			const { [id]: sess } = await keys.get('session', [id])
			if (sess) {
				const record = libsignal.SessionRecord.deserialize(sess)
				return record
			}
		},
		storeSession: async (id: string, session: libsignal.SessionRecord) => {
			await keys.set({ session: { [id]: session.serialize() } })
		},
		isTrustedIdentity: () => {
			return true
		},
		loadPreKey: async (id: number | string) => {
			const keyId = id.toString()
			const { [keyId]: key } = await keys.get('pre-key', [keyId])
			if (key) {
				return {
					privKey: Buffer.from(key.private),
					pubKey: Buffer.from(key.public)
				}
			}
		},
		removePreKey: (id: number) => keys.set({ 'pre-key': { [id]: null } }),
		loadSignedPreKey: () => {
			const key = creds.signedPreKey
			return {
				privKey: Buffer.from(key.keyPair.private),
				pubKey: Buffer.from(key.keyPair.public)
			}
		},
		loadSenderKey: async (senderKeyName: SenderKeyName) => {
			const keyId = senderKeyName.toString()
			const { [keyId]: key } = await keys.get('sender-key', [keyId])
			if (key) {
				return SenderKeyRecord.deserialize(key)
			}

			return new SenderKeyRecord()
		},
		storeSenderKey: async (senderKeyName: SenderKeyName, key: SenderKeyRecord) => {
			try {
				const keyId = senderKeyName.toString()
				const serialized = JSON.stringify(key.serialize())
				await keys.set({ 'sender-key': { [keyId]: Buffer.from(serialized, 'utf-8') } })
			} catch (error) {
				logger.error({ senderKeyName, error, key }, 'Failed to store sender key')
				throw error
			}
		},
		getOurRegistrationId: () => creds.registrationId,
		getOurIdentity: () => {
			const { signedIdentityKey } = creds
			return {
				privKey: Buffer.from(signedIdentityKey.private),
				pubKey: generateSignalPubKey(signedIdentityKey.public)
			}
		}
	}
}
