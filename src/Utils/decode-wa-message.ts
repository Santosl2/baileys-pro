import { Boom } from '@hapi/boom'
import { proto } from '../../WAProto/index.js'
import { SignalRepository, WAMessage, WAMessageKey } from '../Types'
import {
	areJidsSameUser,
	BinaryNode,
	isJidBroadcast,
	isJidGroup,
	isJidMetaIa,
	isJidNewsletter,
	isJidStatusBroadcast,
	isJidUser,
	isLidUser,
	jidDecode,
	jidEncode
} from '../WABinary'
import { unpadRandomMax16 } from './generics'
import { ILogger } from './logger'

export const NO_MESSAGE_FOUND_ERROR_TEXT = 'Message absent from node'
export const MISSING_KEYS_ERROR_TEXT = 'Key used already or never filled'

const shouldTryGroupAuthorFallback = (err: unknown) => {
	const errMsg = err instanceof Error ? err.message : ''
	return errMsg.includes('No session found to decrypt message')
}

const getGroupAuthorJids = (author: string, key: WAMessageKey) => {
	const arr = [author, key.participantLid, key.participantPn].filter(Boolean)

	for (const jid of arr) {
		const { server, device, user } = jidDecode(jid)!

		// include fallback jid with device 0 if the jid has a device component, to handle cases where messages are encrypted to the wrong device jid
		if (device && device !== 0) {
			arr.push(jidEncode(user, server, 0))
		}
	}

	const jids = new Set(arr.filter(Boolean))

	return Array.from(jids) as string[]
}

const decryptGroupWithAuthorFallback = async (
	repository: SignalRepository,
	logger: ILogger,
	params: {
		group: string
		author: string
		content: Uint8Array
		fullMessageKey: WAMessageKey
		groupAuthorJids: string[]
	}
) => {
	const { group, author, content, groupAuthorJids } = params
	let lastDecryptErr: unknown
	for (const authorJid of groupAuthorJids) {
		try {
			return await repository.decryptGroupMessage({
				group,
				authorJid,
				msg: content
			})
		} catch (err) {
			lastDecryptErr = err
			const isLastAuthorJid = authorJid === groupAuthorJids[groupAuthorJids.length - 1]

			logger.error(
				{ group, author, triedAuthorJid: authorJid, fallbackAuthorJids: groupAuthorJids },
				'group decrypt had no sender session for author jid, trying fallback jid'
			)

			if (!shouldTryGroupAuthorFallback(err) || isLastAuthorJid) {
				throw err
			}
		}
	}

	throw lastDecryptErr
}

const processSenderKeyDistributionWithFallback = async (
	repository: SignalRepository,
	groupAuthorJids: string[],
	item: proto.Message.ISenderKeyDistributionMessage
) => {
	let processErr: unknown
	for (const authorJid of groupAuthorJids) {
		try {
			await repository.processSenderKeyDistributionMessage({ authorJid, item })
			return
		} catch (err) {
			processErr = err
		}
	}

	if (processErr) {
		throw processErr
	}
}

const processSenderKeyDistributionWithFallbackAndLog = async (
	repository: SignalRepository,
	logger: ILogger,
	params: {
		groupAuthorJids: string[]
		item: proto.Message.ISenderKeyDistributionMessage
		fullMessageKey: WAMessageKey
		content: Uint8Array
	}
) => {
	const { groupAuthorJids, item, fullMessageKey, content } = params
	try {
		await processSenderKeyDistributionWithFallback(repository, groupAuthorJids, item)
	} catch (err) {
		logger.error(
			{ key: fullMessageKey, err, msg: content, fallbackAuthorJids: groupAuthorJids },
			'failed to process sender key distribution message'
		)
	}
}

export const NACK_REASONS = {
	ParsingError: 487,
	UnrecognizedStanza: 488,
	UnrecognizedStanzaClass: 489,
	UnrecognizedStanzaType: 490,
	InvalidProtobuf: 491,
	InvalidHostedCompanionStanza: 493,
	MissingMessageSecret: 495,
	SignalErrorOldCounter: 496,
	MessageDeletedOnPeer: 499,
	UnhandledError: 500,
	UnsupportedAdminRevoke: 550,
	UnsupportedLIDGroup: 551,
	DBOperationFailed: 552
}

type MessageType =
	| 'chat'
	| 'peer_broadcast'
	| 'other_broadcast'
	| 'group'
	| 'direct_peer_status'
	| 'other_status'
	| 'newsletter'

/**
 * Decode the received node as a message.
 * @note this will only parse the message, not decrypt it
 */
export function decodeMessageNode(stanza: BinaryNode, meId: string, meLid: string) {
	let msgType: MessageType
	let chatId: string
	let author: string

	const msgId = stanza.attrs.id
	const from = stanza.attrs.from
	const participant: string | undefined = stanza.attrs.participant
	const recipient: string | undefined = stanza.attrs.recipient

	const isMe = (jid: string) => areJidsSameUser(jid, meId)
	const isMeLid = (jid: string) => areJidsSameUser(jid, meLid)

	if (isJidUser(from) || isLidUser(from)) {
		if (recipient && !isJidMetaIa(recipient)) {
			if (!isMe(from) && !isMeLid(from)) {
				throw new Boom('receipient present, but msg not from me', { data: stanza })
			}

			chatId = recipient
		} else {
			chatId = from
		}

		msgType = 'chat'
		author = from
	} else if (isJidGroup(from)) {
		if (!participant) {
			throw new Boom('No participant in group message')
		}

		msgType = 'group'
		author = participant
		chatId = from
	} else if (isJidBroadcast(from)) {
		if (!participant) {
			throw new Boom('No participant in group message')
		}

		const isParticipantMe = isMe(participant)
		if (isJidStatusBroadcast(from)) {
			msgType = isParticipantMe ? 'direct_peer_status' : 'other_status'
		} else {
			msgType = isParticipantMe ? 'peer_broadcast' : 'other_broadcast'
		}

		chatId = from
		author = participant
	} else if (isJidNewsletter(from)) {
		msgType = 'newsletter'
		chatId = from
		author = from
	} else {
		throw new Boom('Unknown message type', { data: stanza })
	}

	const fromMe = (isLidUser(from) || isLidUser(participant) ? isMeLid : isMe)(
		stanza.attrs.participant || stanza.attrs.from
	)
	const pushname = stanza?.attrs?.notify

	const senderPn = isJidUser(stanza.attrs.from) ? stanza.attrs.from : stanza.attrs.sender_pn
	const senderLid = isLidUser(stanza.attrs.from) ? stanza.attrs.from : stanza.attrs.sender_lid

	const participantPn = isJidUser(stanza.attrs.participant) ? stanza.attrs.participant : stanza.attrs.participant_pn

	const participantLid = isLidUser(stanza.attrs.participant) ? stanza.attrs.participant : stanza.attrs.participant_lid

	const key: WAMessageKey = {
		remoteJid: chatId,
		fromMe,
		id: msgId,
		senderLid,
		senderPn,
		participant,
		participantPn,
		participantLid,
		...(msgType === 'newsletter' && stanza.attrs.server_id ? { server_id: stanza.attrs.server_id } : {})
	}

	const fullMessage: WAMessage = {
		key,
		category: stanza.attrs.category,
		messageTimestamp: +stanza.attrs.t,
		pushName: pushname,
		broadcast: isJidBroadcast(from)
	}

	if (key.fromMe) {
		fullMessage.status = proto.WebMessageInfo.Status.SERVER_ACK
	}

	return {
		fullMessage,
		author,
		sender: msgType === 'chat' ? author : chatId
	}
}

export const decryptMessageNode = (
	stanza: BinaryNode,
	meId: string,
	meLid: string,
	repository: SignalRepository,
	logger: ILogger
) => {
	const { fullMessage, author, sender } = decodeMessageNode(stanza, meId, meLid)
	return {
		fullMessage,
		category: stanza.attrs.category,
		author,
		async decrypt() {
			let decryptables = 0
			if (Array.isArray(stanza.content)) {
				for (const { tag, attrs, content } of stanza.content) {
					if (tag === 'verified_name' && content instanceof Uint8Array) {
						const cert = proto.VerifiedNameCertificate.decode(content)
						const details = proto.VerifiedNameCertificate.Details.decode(cert.details!)
						fullMessage.verifiedBizName = details.verifiedName
					}

					if (tag === 'unavailable' && attrs.type === 'view_once') {
						fullMessage.key.isViewOnce = true
					}

					if (tag !== 'enc' && tag !== 'plaintext') {
						continue
					}

					if (!(content instanceof Uint8Array)) {
						continue
					}

					decryptables += 1

					let msgBuffer!: Uint8Array
					const groupAuthorJids = getGroupAuthorJids(author, fullMessage.key)

					try {
						const e2eType = tag === 'plaintext' ? 'plaintext' : attrs.type
						switch (e2eType) {
							case 'skmsg':
								msgBuffer = await decryptGroupWithAuthorFallback(repository, logger, {
									group: sender,
									author,
									content,
									fullMessageKey: fullMessage.key,
									groupAuthorJids
								})

								break
							case 'pkmsg':
							case 'msg':
								const user = isJidUser(sender) ? sender : author
								msgBuffer = await repository.decryptMessage({
									jid: user,
									type: e2eType,
									ciphertext: content
								})
								break
							case 'plaintext':
								msgBuffer = content
								break
							default:
								throw new Error(`Unknown e2e type: ${e2eType}`)
						}

						let msg: proto.IMessage = proto.Message.decode(
							e2eType !== 'plaintext' ? unpadRandomMax16(msgBuffer) : msgBuffer
						)
						msg = msg.deviceSentMessage?.message || msg
						if (msg.senderKeyDistributionMessage) {
							await processSenderKeyDistributionWithFallbackAndLog(repository, logger, {
								groupAuthorJids,
								item: msg.senderKeyDistributionMessage,
								fullMessageKey: fullMessage.key,
								content
							})
						}

						if (fullMessage.message) {
							Object.assign(fullMessage.message, msg)
						} else {
							fullMessage.message = msg
						}
					} catch (err) {
						const errorContext = {
							key: fullMessage.key,
							err,
							errMessage: err.message,
							messageType: tag === 'plaintext' ? 'plaintext' : attrs.type,
							sender,
							author
						}

						logger.error(errorContext, 'failed to decrypt message')

						fullMessage.messageStubType = proto.WebMessageInfo.StubType.CIPHERTEXT
						fullMessage.messageStubParameters = [err.message]
					}
				}
			}

			// if nothing was found to decrypt
			if (!decryptables) {
				fullMessage.messageStubType = proto.WebMessageInfo.StubType.CIPHERTEXT
				fullMessage.messageStubParameters = [NO_MESSAGE_FOUND_ERROR_TEXT]
			}
		}
	}
}
