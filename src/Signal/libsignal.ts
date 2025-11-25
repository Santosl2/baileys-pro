import { SignalAuthState, SignalKeyStoreWithTransaction } from '../Types'
import { SignalRepository } from '../Types/Signal'
import logger from '../Utils/logger'
import { jidDecode, WAJIDDomains } from '../WABinary'
import type { SignalStorage } from 'whatsapp-rust-bridge'
import {
	GroupCipher,
	GroupSessionBuilder,
	ProtocolAddress,
	SenderKeyDistributionMessage,
	SenderKeyName,
	SessionBuilder,
	SessionCipher,
	SessionRecord
} from 'whatsapp-rust-bridge'

export function makeLibSignalRepository(auth: SignalAuthState): SignalRepository {
	const storage = signalStorage(auth)
	const parsedKeys = auth.keys as SignalKeyStoreWithTransaction

	return {
		async validateSession(jid: string) {
			return { exists: true }
		},
		decryptGroupMessage({ group, authorJid, msg }) {
			const senderAddr = jidToSignalProtocolAddress(authorJid)
			const cipher = new GroupCipher(storage, group, senderAddr)

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

			const senderAddr = jidToSignalProtocolAddress(authorJid)

			const senderName = new SenderKeyName(item.groupId, senderAddr)
			const senderMsg = SenderKeyDistributionMessage.deserialize(item.axolotlSenderKeyDistributionMessage!)

			return parsedKeys.transaction(async () => {
				await builder.process(senderName, senderMsg)
			})
		},
		async decryptMessage({ jid, type, ciphertext }) {
			const addr = jidToSignalProtocolAddress(jid)
			const session = new SessionCipher(storage, addr)

			async function doDecrypt() {
				let result: Uint8Array
				switch (type) {
					case 'pkmsg':
						result = await session.decryptPreKeyWhisperMessage(ciphertext)
						break
					case 'msg':
						result = await session.decryptWhisperMessage(ciphertext)
						break
				}

				return result
			}

			// If it's not a sync message, we need to ensure atomicity
			// For regular messages, we use a transaction to ensure atomicity
			return parsedKeys.transaction(async () => {
				return await doDecrypt()
			})
		},
		async encryptMessage({ jid, data }) {
			const addr = jidToSignalProtocolAddress(jid)
			const cipher = new SessionCipher(storage, addr)

			// Use transaction to ensure atomicity
			return parsedKeys.transaction(async () => {
				const { type: sigType, body } = await cipher.encrypt(data)
				const type = sigType === 3 ? 'pkmsg' : 'msg'
				return { type, ciphertext: body }
			})
		},
		async encryptGroupMessage({ group, meId, data }) {
			const builder = new GroupSessionBuilder(storage)
			const meAddr = jidToSignalProtocolAddress(meId)
			const senderName = jidToSignalSenderKeyName(group, meId)

			const senderKeyDistributionMessage = await builder.create(senderName)

			const cipher = new GroupCipher(storage, group, meAddr)

			return parsedKeys.transaction(async () => {
				const ciphertext = await cipher.encrypt(data)

				return {
					ciphertext,
					senderKeyDistributionMessage: senderKeyDistributionMessage.serialize()
				}
			})
		},
		async injectE2ESession({ jid, session }) {
			logger.trace({ jid }, 'injecting E2EE session')
			const cipher = new SessionBuilder(storage, jidToSignalProtocolAddress(jid))
			return parsedKeys.transaction(async () => {
				await cipher.initOutgoing(session)
			})
		},
		jidToSignalProtocolAddress(jid) {
			return jidToSignalProtocolAddress(jid).toString()
		}
	}
}

const jidToSignalProtocolAddress = (jid: string): ProtocolAddress => {
	const decoded = jidDecode(jid)!
	const { user, device, server, domainType } = decoded

	if (!user) {
		throw new Error(
			`JID decoded but user is empty: "${jid}" -> user: "${user}", server: "${server}", device: ${device}`
		)
	}

	const signalUser = domainType !== WAJIDDomains.WHATSAPP ? `${user}_${domainType}` : user
	const finalDevice = device || 0

	if (device === 99 && decoded.server !== 'hosted' && decoded.server !== 'hosted.lid') {
		throw new Error('Unexpected non-hosted device JID with device 99. This ID seems invalid. ID:' + jid)
	}

	return new ProtocolAddress(signalUser, finalDevice)
}

const jidToSignalSenderKeyName = (group: string, user: string): SenderKeyName => {
	return new SenderKeyName(group, jidToSignalProtocolAddress(user))
}

function signalStorage({ creds, keys }: SignalAuthState): SignalStorage {
	// Shared function to resolve PN signal address to LID if mapping exists
	const resolveLIDSignalAddress = async (id: string): Promise<string> => {
		if (id.includes('.')) {
			const [deviceId, device] = id.split('.')
			const [user, domainType_] = deviceId!.split('_')
			const domainType = parseInt(domainType_ || '0')

			if (domainType === WAJIDDomains.LID || domainType === WAJIDDomains.HOSTED_LID) return id

			const pnJid = `${user!}${device !== '0' ? `:${device}` : ''}@${domainType === WAJIDDomains.HOSTED ? 'hosted' : 's.whatsapp.net'}`
			return pnJid
			// const lidForPN = await lidMapping.getLIDForPN(pnJid)
			// if (lidForPN) {
			// 	const lidAddr = jidToSignalProtocolAddress(lidForPN)
			// 	return lidAddr.toString()
			// }
		}

		return id
	}

	return {
		loadSession: async (id: string) => {
			try {
				const wireJid = await resolveLIDSignalAddress(id)
				const { [wireJid]: sess } = await keys.get('session', [wireJid])
				if (sess) {
					return sess
				}

				return null
			} catch (e) {
				return null
			}
		},
		storeSession: async (id: string, session: SessionRecord) => {
			const wireJid = await resolveLIDSignalAddress(id)
			await keys.set({ session: { [wireJid]: session.serialize() } })
		},
		isTrustedIdentity: () => {
			return true // todo: implement
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
