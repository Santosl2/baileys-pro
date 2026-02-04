import * as libsignal from 'libsignal'
import { PreKeyWhisperMessage } from 'libsignal/src/protobufs'
import { LRUCache } from 'lru-cache'
import { SignalAuthState, SignalKeyStoreWithTransaction } from '../Types'
import { SignalRepository } from '../Types/Signal'
import { generateSignalPubKey } from '../Utils'
import logger from '../Utils/logger'
import { jidDecode } from '../WABinary'
import type { SenderKeyStore } from './Group/group_cipher'
import { SenderKeyName } from './Group/sender-key-name'
import { SenderKeyRecord } from './Group/sender-key-record'
import { GroupCipher, GroupSessionBuilder, SenderKeyDistributionMessage } from './Group'

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
	const storage: SenderKeyStore = signalStorage(auth)
	return {
		erroredMessages: new LRUCache({
			max: 20
		}),
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
		decryptGroupMessage({ group, authorJid, msg }) {
			const senderName = jidToSignalSenderKeyName(group, authorJid)
			const cipher = new GroupCipher(storage, senderName)

			// Use transaction to ensure atomicity
			return (auth.keys as SignalKeyStoreWithTransaction).transaction(async () => {
				return cipher.decrypt(msg)
			})
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

			return (auth.keys as SignalKeyStoreWithTransaction).transaction(async () => {
				const { [senderNameStr]: senderKey } = await auth.keys.get('sender-key', [senderNameStr])
				if (!senderKey) {
					await storage.storeSenderKey(senderName, new SenderKeyRecord())
				}

				await builder.process(senderName, senderMsg)
			})
		},
		async decryptMessage({ jid, type, ciphertext }) {
			const addr = jidToSignalProtocolAddress(jid)
			const session = new libsignal.SessionCipher(storage, addr)

			// Use transaction to ensure atomicityAdd commentMore actions
			return (auth.keys as SignalKeyStoreWithTransaction).transaction(async () => {
				if (type === 'pkmsg') {
					const identityKey = extractIdentityFromPkmsg(ciphertext)
					if (identityKey) {
						const addrStr = addr.toString()
						const identityChanged = await storage.saveIdentity(addrStr, identityKey)
						if (identityChanged) {
							logger.debug(
								{ jid, addr: addrStr },
								'identity key changed or new contact, session will be re-established'
							) // todo: remove later
							logger.info({ jid, addr: addrStr }, 'identity key changed or new contact, session will be re-established')
						}
					}
				}

				let result: Buffer
				switch (type) {
					case 'pkmsg':
						result = await session.decryptPreKeyWhisperMessage(ciphertext)
						break
					case 'msg':
						result = await session.decryptWhisperMessage(ciphertext)
						break
				}

				return result
			})
		},
		async encryptMessage({ jid, data }) {
			const addr = jidToSignalProtocolAddress(jid)
			const cipher = new libsignal.SessionCipher(storage, addr)

			// Use transaction to ensure atomicityAdd commentMore actions
			return (auth.keys as SignalKeyStoreWithTransaction).transaction(async () => {
				try {
					const { type: sigType, body } = await cipher.encrypt(data)
					const type = sigType === 3 ? 'pkmsg' : 'msg'
					return { type, ciphertext: Buffer.from(body, 'binary') }
				} catch (error) {
					logger.info(`Encryption failed ${error}`)
					throw error
				}
			})
		},
		async encryptGroupMessage({ group, meId, data }) {
			const senderName = jidToSignalSenderKeyName(group, meId)
			const builder = new GroupSessionBuilder(storage)

			const senderNameStr = senderName.toString()

			// Use transaction to ensure atomicity
			return (auth.keys as SignalKeyStoreWithTransaction).transaction(async () => {
				try {
					const { [senderNameStr]: senderKey } = await auth.keys.get('sender-key', [senderNameStr])
					if (!senderKey) {
						await storage.storeSenderKey(senderName, new SenderKeyRecord())
					}

					const senderKeyDistributionMessage = await builder.create(senderName)
					const session = new GroupCipher(storage, senderName)
					const ciphertext = await session.encrypt(data)

					return {
						ciphertext,
						senderKeyDistributionMessage: senderKeyDistributionMessage.serialize()
					}
				} catch (error) {
					logger.info(`Group message encryption failed ${error}`)
					throw error
				}
			})
		},
		async injectE2ESession({ jid, session }) {
			const cipher = new libsignal.SessionBuilder(storage, jidToSignalProtocolAddress(jid))

			// Use transaction to ensure atomicity
			return (auth.keys as SignalKeyStoreWithTransaction).transaction(async () => {
				await cipher.initOutgoing(session)
			})
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
		loadSession: async (id: string) => {
			const { [id]: sess } = await keys.get('session', [id])
			if (sess) {
				return libsignal.SessionRecord.deserialize(sess)
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
