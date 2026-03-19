import NodeCache from '@cacheable/node-cache'
import { Boom } from '@hapi/boom'
import { randomBytes } from 'crypto'
import Long from 'long'
import { proto } from '../../WAProto'
import {
	DEFAULT_CACHE_MAX_KEYS,
	DEFAULT_CACHE_TTLS,
	KEY_BUNDLE_TYPE,
	MIN_PREKEY_COUNT,
	PLACEHOLDER_MAX_AGE_SECONDS,
	STATUS_EXPIRY_SECONDS
} from '../Defaults'
import {
	MessageReceiptType,
	MessageRelayOptions,
	MessageUserReceipt,
	NewsletterEventPayloads,
	SocketConfig,
	WACallEvent,
	WAMessage,
	WAMessageKey,
	WAMessageStatus,
	WAMessageStubType,
	WAPatchName
} from '../Types'
import {
	aesDecryptCTR,
	aesEncryptGCM,
	cleanMessage,
	Curve,
	decodeMediaRetryNode,
	decodeMessageNode,
	decryptMessageNode,
	delay,
	derivePairingCodeKey,
	encodeBigEndian,
	encodeSignedDeviceIdentity,
	getCallStatusFromNode,
	getHistoryMsg,
	getNextPreKeys,
	getStatusFromReceiptType,
	hkdf,
	MISSING_KEYS_ERROR_TEXT,
	NACK_REASONS,
	NO_MESSAGE_FOUND_ERROR_TEXT,
	toNumber,
	unixTimestampSeconds,
	xmppPreKey,
	xmppSignedPreKey
} from '../Utils'
import { handleIdentityChange } from '../Utils/identity-change-handler'
import { makeMutex } from '../Utils/make-mutex'
import {
	areJidsSameUser,
	BinaryNode,
	binaryNodeToString,
	getAllBinaryNodeChildren,
	getBinaryNodeChild,
	getBinaryNodeChildBuffer,
	getBinaryNodeChildren,
	getBinaryNodeChildString,
	isJidGroup,
	isJidNewsletter,
	isJidStatusBroadcast,
	isJidUser,
	jidDecode,
	jidNormalizedUser,
	JidWithDevice,
	S_WHATSAPP_NET
} from '../WABinary'
import { extractGroupMetadata } from './groups'
import { makeMessagesSocket } from './messages-send'

export const makeMessagesRecvSocket = (config: SocketConfig) => {
	const {
		logger,
		retryRequestDelayMs,
		maxMsgRetryCount,
		enableAutoSessionRecreation,
		getMessage,
		shouldIgnoreJid,
		userDevicesCache,
		recentMessageSentHistory
	} = config
	const sock = makeMessagesSocket(config)
	const {
		ev,
		authState,
		ws,
		messageMutex,
		receiptMutex,
		notificationMutex,
		signalRepository,
		query,
		upsertMessage,
		resyncAppState,
		onUnexpectedError,
		assertSessions,
		sendNode,
		relayMessage,
		sendReceipt,
		uploadPreKeys,
		sendPeerDataOperationMessage,
		messageRetryManager
	} = sock

	/** this mutex ensures that each retryRequest will wait for the previous one to finish */
	const retryMutex = makeMutex()

	const identityAssertDebounce = new NodeCache({
		stdTTL: 5,
		useClones: false,
		maxKeys: DEFAULT_CACHE_MAX_KEYS.IDENTITY_ASSERT
	})

	const msgRetryCache =
		config.msgRetryCounterCache ||
		new NodeCache({
			stdTTL: DEFAULT_CACHE_TTLS.MSG_RETRY, // 1 hour
			useClones: false,
			maxKeys: DEFAULT_CACHE_MAX_KEYS.MSG_RETRY
		})
	const callOfferCache =
		config.callOfferCache ||
		new NodeCache({
			stdTTL: DEFAULT_CACHE_TTLS.CALL_OFFER, // 5 mins
			useClones: false,
			maxKeys: DEFAULT_CACHE_MAX_KEYS.CALL_OFFER
		})

	const placeholderResendCache =
		config.placeholderResendCache ||
		new NodeCache({
			stdTTL: DEFAULT_CACHE_TTLS.MSG_RETRY, // 1 hour
			useClones: false,
			maxKeys: DEFAULT_CACHE_MAX_KEYS.PLACEHOLDER_RESEND
		})

	let sendActiveReceipts = false

	const sendMessageAck = async ({ tag, attrs }: BinaryNode, errorCode?: number) => {
		const meId = authState.creds.me?.id
		const stanza: BinaryNode = {
			tag: 'ack',
			attrs: {
				id: attrs.id,
				to: attrs.from,
				class: tag
			}
		}

		if (!!errorCode) {
			stanza.attrs.error = errorCode.toString()
		}

		if (!!attrs.participant) {
			stanza.attrs.participant = attrs.participant
		}

		if (!!attrs.recipient) {
			stanza.attrs.recipient = attrs.recipient
		}

		if (!!attrs.type) {
			stanza.attrs.type = attrs.type
		}

		if (tag === 'message' && meId) {
			stanza.attrs.from = meId
		}

		logger.debug({ recv: { tag, attrs }, sent: stanza.attrs }, 'sent ack')
		await sendNode(stanza)
	}

	const rejectCall = async (callId: string, callFrom: string) => {
		const stanza: BinaryNode = {
			tag: 'call',
			attrs: {
				from: authState.creds.me!.id,
				to: callFrom
			},
			content: [
				{
					tag: 'reject',
					attrs: {
						'call-id': callId,
						'call-creator': callFrom,
						count: '0'
					},
					content: undefined
				}
			]
		}
		await query(stanza)
	}

	const sendRetryRequest = async (node: BinaryNode, forceIncludeKeys = false) => {
		const { fullMessage } = decodeMessageNode(node, authState.creds.me!.id, authState.creds.me!.lid || '')
		const { key: msgKey } = fullMessage
		const msgId = msgKey.id!
		const fromJid = node.attrs.from

		let retryCount = Number(msgRetryCache.get(msgId) || 0) || 0
		if (retryCount > maxMsgRetryCount) {
			const placeholderRequest = await requestPlaceholderResend(msgKey)
			logger.debug(`sendRetryRequest: requested placeholder resend for message ${placeholderRequest}`)
			logger.debug({ retryCount, msgId }, 'reached retry limit, clearing')
			msgRetryCache.del(msgId)
			return
		}

		retryCount += 1
		msgRetryCache.set(msgId, retryCount)

		const { account, signedPreKey, signedIdentityKey: identityKey } = authState.creds

		const fromId = isJidGroup(fromJid) ? node.attrs.participant : fromJid

		let shouldRecreateSession = (await signalRepository.validateSession(fromId || fromJid)).exists !== true
		let recreateReason = ''

		if (enableAutoSessionRecreation && messageRetryManager && retryCount > 1) {
			try {
				// Check if we have a session with this JID
				const sessionId = signalRepository.jidToSignalProtocolAddress(fromJid)
				const hasSession = await signalRepository.validateSession(fromJid)
				const result = messageRetryManager.shouldRecreateSession(fromJid, hasSession.exists)
				shouldRecreateSession = result.recreate
				recreateReason = result.reason

				if (shouldRecreateSession) {
					logger.debug({ fromJid, retryCount, reason: recreateReason }, 'recreating session for retry')
					// Delete existing session to force recreation
					await authState.keys.set({ session: { [sessionId]: null } })
					forceIncludeKeys = true
				}
			} catch (error) {
				logger.warn({ error, fromJid }, 'failed to check session recreation')
			}
		}

		const deviceIdentity = encodeSignedDeviceIdentity(account!, true)
		await authState.keys.transaction(async () => {
			const receipt: BinaryNode = {
				tag: 'receipt',
				attrs: {
					id: msgId,
					type: 'retry',
					to: node.attrs.from
				},
				content: [
					{
						tag: 'retry',
						attrs: {
							count: retryCount.toString(),
							id: node.attrs.id,
							t: node.attrs.t,
							v: '1'
						}
					},
					{
						tag: 'registration',
						attrs: {},
						content: encodeBigEndian(authState.creds.registrationId)
					}
				]
			}

			if (node.attrs.recipient) {
				receipt.attrs.recipient = node.attrs.recipient
			}

			if (node.attrs.participant) {
				receipt.attrs.participant = node.attrs.participant
			}

			if (retryCount > 1 || forceIncludeKeys || shouldRecreateSession) {
				const { update, preKeys } = await getNextPreKeys(authState, 1)

				const [keyId] = Object.keys(preKeys)
				const key = preKeys[+keyId]

				const content = receipt.content! as BinaryNode[]
				content.push({
					tag: 'keys',
					attrs: {},
					content: [
						{ tag: 'type', attrs: {}, content: Buffer.from(KEY_BUNDLE_TYPE) },
						{ tag: 'identity', attrs: {}, content: identityKey.public },
						xmppPreKey(key, +keyId),
						xmppSignedPreKey(signedPreKey),
						{ tag: 'device-identity', attrs: {}, content: deviceIdentity }
					]
				})

				ev.emit('creds.update', update)
			}

			await sendNode(receipt)

			logger.info({ msgAttrs: node.attrs, retryCount }, 'sent retry receipt')
		})
	}

	const handleEncryptNotification = async (node: BinaryNode) => {
		const from = node.attrs.from
		if (from === S_WHATSAPP_NET) {
			const countChild = getBinaryNodeChild(node, 'count')
			const count = +countChild.attrs.value
			const shouldUploadMorePreKeys = count < MIN_PREKEY_COUNT

			logger.debug({ count, shouldUploadMorePreKeys }, 'recv pre-key count')
			if (shouldUploadMorePreKeys) {
				await uploadPreKeys()
			}
		} else {
			const result = await handleIdentityChange(node, {
				meId: authState.creds.me?.id,
				meLid: authState.creds.me?.lid,
				validateSession: signalRepository.validateSession,
				assertSessions,
				debounceCache: identityAssertDebounce,
				logger
			})

			if (result.action === 'no_identity_node') {
				logger.info({ node }, 'unknown encrypt notification')
			}
		}
	}

	const devicesMutex = makeMutex()

	const handleDevicesNotification = async (node: BinaryNode) => {
		const [child] = getAllBinaryNodeChildren(node)
		const from = jidNormalizedUser(node.attrs.from)

		const devices = getBinaryNodeChildren(child, 'device')
		if (areJidsSameUser(from, authState.creds.me!.id) || areJidsSameUser(from, authState.creds.me!.lid)) {
			const deviceJids = devices.map(d => d.attrs.jid)
			logger.info({ deviceJids }, 'got my own devices')
		}

		const deviceJid = devices[0].attrs.jid
		const { user, device } = jidDecode(deviceJid)!
		const tag = child.tag as 'add' | 'remove' | 'update'

		if (!deviceJid) {
			logger.debug({ tag }, 'no device jid in notification, skipping')
			return
		}

		await devicesMutex.mutex(async () => {
			if (tag === 'update') {
				logger.debug({ user }, `${user}'s device list updated, dropping cached devices`)
				await userDevicesCache?.del(user)
				return
			}

			const existingCache: JidWithDevice[] = (await userDevicesCache?.get(user)) || ([] as JidWithDevice[])

			if (!existingCache.length) {
				logger.debug({ user, tag }, 'device list not cached, skipping cache update')
				return
			}

			const deviceHash = child.attrs.device_hash

			let updatedDevices: JidWithDevice[] = []

			switch (tag) {
				case 'add':
					logger.info({ deviceHash }, 'device added')
					updatedDevices = [...existingCache.filter(d => d.device !== device), { user, device }]
					break
				case 'remove':
					logger.info({ deviceHash }, 'device removed')
					updatedDevices = existingCache.filter(d => d.device !== device) || []
					break
				default:
					logger.debug({ tag }, 'Unknown device list change tag')
					return
			}

			// const hash = generateParticipantHashV2(updatedDevices.map(d => jidEncode(d.user, 'lid', d.device)))

			// // ?
			// if (hash === deviceHash) {
			// 	logger.debug({ from, deviceHash, expectedHash: hash }, 'device hash mismatch, skipping cache update')
			// 	await userDevicesCache?.del(user)
			// }

			if (updatedDevices.length > 0) {
				await userDevicesCache?.set(user, updatedDevices)
			}
		})
	}

	const handleGroupNotification = (participant: string, child: BinaryNode, msg: Partial<proto.IWebMessageInfo>) => {
		const participantJid = getBinaryNodeChild(child, 'participant')?.attrs?.jid || participant
		switch (child?.tag) {
			case 'create':
				const metadata = extractGroupMetadata(child)

				msg.messageStubType = WAMessageStubType.GROUP_CREATE
				msg.messageStubParameters = [metadata.subject]
				msg.key = { participant: metadata.owner }

				ev.emit('chats.upsert', [
					{
						id: metadata.id,
						name: metadata.subject,
						conversationTimestamp: metadata.creation
					}
				])
				ev.emit('groups.upsert', [
					{
						...metadata,
						author: participant
					}
				])
				break
			case 'ephemeral':
			case 'not_ephemeral':
				msg.message = {
					protocolMessage: {
						type: proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING,
						ephemeralExpiration: +(child.attrs.expiration || 0)
					}
				}
				break
			case 'modify':
				const oldNumber = getBinaryNodeChildren(child, 'participant').map(p => p.attrs.jid)
				msg.messageStubParameters = oldNumber || []
				msg.messageStubType = WAMessageStubType.GROUP_PARTICIPANT_CHANGE_NUMBER
				break
			case 'promote':
			case 'demote':
			case 'remove':
			case 'add':
			case 'leave':
				const stubType = `GROUP_PARTICIPANT_${child.tag.toUpperCase()}`
				msg.messageStubType = WAMessageStubType[stubType]

				const participants = getBinaryNodeChildren(child, 'participant').map(p => p.attrs.jid)
				if (
					participants.length === 1 &&
					// if recv. "remove" message and sender removed themselves
					// mark as left
					areJidsSameUser(participants[0], participant) &&
					child.tag === 'remove'
				) {
					msg.messageStubType = WAMessageStubType.GROUP_PARTICIPANT_LEAVE
				}

				msg.messageStubParameters = participants
				break
			case 'subject':
				msg.messageStubType = WAMessageStubType.GROUP_CHANGE_SUBJECT
				msg.messageStubParameters = [child.attrs.subject]
				break
			case 'description':
				const description = getBinaryNodeChild(child, 'body')?.content?.toString()
				msg.messageStubType = WAMessageStubType.GROUP_CHANGE_DESCRIPTION
				msg.messageStubParameters = description ? [description] : undefined
				break
			case 'announcement':
			case 'not_announcement':
				msg.messageStubType = WAMessageStubType.GROUP_CHANGE_ANNOUNCE
				msg.messageStubParameters = [child.tag === 'announcement' ? 'on' : 'off']
				break
			case 'locked':
			case 'unlocked':
				msg.messageStubType = WAMessageStubType.GROUP_CHANGE_RESTRICT
				msg.messageStubParameters = [child.tag === 'locked' ? 'on' : 'off']
				break
			case 'invite':
				msg.messageStubType = WAMessageStubType.GROUP_CHANGE_INVITE_LINK
				msg.messageStubParameters = [child.attrs.code]
				break
			case 'member_add_mode':
				const addMode = child.content
				if (addMode) {
					msg.messageStubType = WAMessageStubType.GROUP_MEMBER_ADD_MODE
					msg.messageStubParameters = [addMode.toString()]
				}

				break
			case 'membership_approval_mode':
				const approvalMode = getBinaryNodeChild(child, 'group_join')
				if (approvalMode) {
					msg.messageStubType = WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_MODE
					msg.messageStubParameters = [approvalMode.attrs.state]
				}

				break
			case 'created_membership_requests':
				msg.messageStubType = WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD
				msg.messageStubParameters = [participantJid, 'created', child.attrs.request_method]
				break
			case 'revoked_membership_requests':
				const isDenied = areJidsSameUser(participantJid, participant)
				msg.messageStubType = WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD
				msg.messageStubParameters = [participantJid, isDenied ? 'revoked' : 'rejected']
				break
		}
	}

	const processNotification = async (node: BinaryNode) => {
		const result: Partial<proto.IWebMessageInfo> = {}
		const [child] = getAllBinaryNodeChildren(node)
		const nodeType = node.attrs.type
		const from = jidNormalizedUser(node.attrs.from)

		switch (nodeType) {
			case 'privacy_token':
				await handlePrivacyTokenNotification(node)
				break
			case 'newsletter':
				await handleNewsletterNotification(node)
				break
			case 'mex':
				await handleMexNewsletterNotification(node)
				break
			case 'w:gp2':
				handleGroupNotification(node.attrs.participant, child, result)
				break
			case 'mediaretry':
				const event = decodeMediaRetryNode(node)
				ev.emit('messages.media-update', [event])
				break
			case 'encrypt':
				await handleEncryptNotification(node)
				break
			case 'fbid:devices':
				logger.error({ node }, 'fbid devices')
				break
			case 'devices':
				try {
					await handleDevicesNotification(node)
				} catch (error) {
					logger.error({ error, node }, 'failed to handle devices notification')
				}

				break
			case 'server_sync':
				const update = getBinaryNodeChild(node, 'collection')
				if (update) {
					const name = update.attrs.name as WAPatchName
					await resyncAppState([name], false)
				}

				break
			case 'picture':
				const setPicture = getBinaryNodeChild(node, 'set')
				const delPicture = getBinaryNodeChild(node, 'delete')

				ev.emit('contacts.update', [
					{
						id: jidNormalizedUser(node?.attrs?.from) || (setPicture || delPicture)?.attrs?.hash || '',
						imgUrl: setPicture ? 'changed' : 'removed'
					}
				])

				if (isJidGroup(from)) {
					const node = setPicture || delPicture
					result.messageStubType = WAMessageStubType.GROUP_CHANGE_ICON

					if (setPicture) {
						result.messageStubParameters = [setPicture.attrs.id]
					}

					result.participant = node?.attrs.author
					result.key = {
						...(result.key || {}),
						participant: setPicture?.attrs.author
					}
				}

				break
			case 'account_sync':
				if (child.tag === 'disappearing_mode') {
					const newDuration = +child.attrs.duration
					const timestamp = +child.attrs.t

					logger.info({ newDuration }, 'updated account disappearing mode')

					ev.emit('creds.update', {
						accountSettings: {
							...authState.creds.accountSettings,
							defaultDisappearingMode: {
								ephemeralExpiration: newDuration,
								ephemeralSettingTimestamp: timestamp
							}
						}
					})
				} else if (child.tag === 'blocklist') {
					const blocklists = getBinaryNodeChildren(child, 'item')

					for (const { attrs } of blocklists) {
						const blocklist = [attrs.jid]
						const type = attrs.action === 'block' ? 'add' : 'remove'
						ev.emit('blocklist.update', { blocklist, type })
					}
				} else if (child.tag === 'devices') {
					const devices = getBinaryNodeChildren(child, 'device')

					for (const { attrs } of devices) {
						const deviceJid = attrs.jid
						const { user, device } = jidDecode(deviceJid)!

						userDevicesCache?.set(user, [{ user, device }]) // cache for 1 min
					}
				}

				break
			case 'link_code_companion_reg':
				const linkCodeCompanionReg = getBinaryNodeChild(node, 'link_code_companion_reg')
				const ref = toRequiredBuffer(getBinaryNodeChildBuffer(linkCodeCompanionReg, 'link_code_pairing_ref'))
				const primaryIdentityPublicKey = toRequiredBuffer(
					getBinaryNodeChildBuffer(linkCodeCompanionReg, 'primary_identity_pub')
				)
				const primaryEphemeralPublicKeyWrapped = toRequiredBuffer(
					getBinaryNodeChildBuffer(linkCodeCompanionReg, 'link_code_pairing_wrapped_primary_ephemeral_pub')
				)
				const codePairingPublicKey = await decipherLinkPublicKey(primaryEphemeralPublicKeyWrapped)
				const companionSharedKey = Curve.sharedKey(
					authState.creds.pairingEphemeralKeyPair.private,
					codePairingPublicKey
				)
				const random = randomBytes(32)
				const linkCodeSalt = randomBytes(32)
				const linkCodePairingExpanded = await hkdf(companionSharedKey, 32, {
					salt: linkCodeSalt,
					info: 'link_code_pairing_key_bundle_encryption_key'
				})
				const encryptPayload = Buffer.concat([
					Buffer.from(authState.creds.signedIdentityKey.public),
					primaryIdentityPublicKey,
					random
				])
				const encryptIv = randomBytes(12)
				const encrypted = aesEncryptGCM(encryptPayload, linkCodePairingExpanded, encryptIv, Buffer.alloc(0))
				const encryptedPayload = Buffer.concat([linkCodeSalt, encryptIv, encrypted])
				const identitySharedKey = Curve.sharedKey(authState.creds.signedIdentityKey.private, primaryIdentityPublicKey)
				const identityPayload = Buffer.concat([companionSharedKey, identitySharedKey, random])
				authState.creds.advSecretKey = (await hkdf(identityPayload, 32, { info: 'adv_secret' })).toString('base64')
				await query({
					tag: 'iq',
					attrs: {
						to: S_WHATSAPP_NET,
						type: 'set',
						id: sock.generateMessageTag(),
						xmlns: 'md'
					},
					content: [
						{
							tag: 'link_code_companion_reg',
							attrs: {
								jid: authState.creds.me!.id,
								stage: 'companion_finish'
							},
							content: [
								{
									tag: 'link_code_pairing_wrapped_key_bundle',
									attrs: {},
									content: encryptedPayload
								},
								{
									tag: 'companion_identity_public',
									attrs: {},
									content: authState.creds.signedIdentityKey.public
								},
								{
									tag: 'link_code_pairing_ref',
									attrs: {},
									content: ref
								}
							]
						}
					]
				})
				authState.creds.registered = true
				ev.emit('creds.update', authState.creds)
		}

		if (Object.keys(result).length) {
			return result
		}
	}

	async function decipherLinkPublicKey(data: Uint8Array | Buffer) {
		const buffer = toRequiredBuffer(data)
		const salt = buffer.slice(0, 32)
		const secretKey = await derivePairingCodeKey(authState.creds.pairingCode!, salt)
		const iv = buffer.slice(32, 48)
		const payload = buffer.slice(48, 80)
		return aesDecryptCTR(payload, secretKey, iv)
	}

	function toRequiredBuffer(data: Uint8Array | Buffer | undefined) {
		if (data === undefined) {
			throw new Boom('Invalid buffer', { statusCode: 400 })
		}

		return data instanceof Buffer ? data : Buffer.from(data)
	}

	const willSendMessageAgain = (id: string, participant: string) => {
		const key = `${id}:${participant}`
		const retryCount = Number(msgRetryCache.get(key)) || 0
		return retryCount < maxMsgRetryCount
	}

	const updateSendMessageAgainCount = (id: string, participant: string) => {
		const key = `${id}:${participant}`
		const newValue = (Number(msgRetryCache.get(key)) || 0) + 1
		msgRetryCache.set(key, newValue)
	}

	const getMessageForRetry = async (key: proto.IMessageKey) => {
		try {
			const recentMsg = recentMessageSentHistory.get(key.remoteJid!, key.id!)

			if (recentMsg) {
				return recentMsg
			}

			const message = await getMessage({ ...key })

			return message
		} catch {
			logger.error({ key }, 'error getting message for retry')
			return undefined
		}
	}

	const sendMessagesAgain = async (key: proto.IMessageKey, ids: string[], retryNode: BinaryNode) => {
		const msgs = await Promise.all(ids.map(id => getMessageForRetry({ ...key, id })))

		const remoteJid = key.remoteJid!
		const participant = key.participant || remoteJid
		// if it's the primary jid sending the request
		// just re-send the message to everyone
		// prevents the first message decryption failure
		const sendToAll = !jidDecode(participant)?.device
		await assertSessions([participant], true)

		if (isJidGroup(remoteJid)) {
			await authState.keys.set({ 'sender-key-memory': { [remoteJid]: null } })
		}

		logger.debug({ participant, sendToAll }, 'forced new session for retry recp')

		for (const [i, msg] of msgs.entries()) {
			if (msg && willSendMessageAgain(ids[i], participant)) {
				updateSendMessageAgainCount(ids[i], participant)
				const msgRelayOpts: MessageRelayOptions = { messageId: ids[i] }

				if (sendToAll) {
					msgRelayOpts.useUserDevicesCache = false
				} else {
					msgRelayOpts.participant = {
						jid: participant,
						count: +retryNode.attrs.count
					}
				}

				await relayMessage(key.remoteJid!, msg, msgRelayOpts)
			} else {
				logger.debug({ jid: key.remoteJid, id: ids[i] }, 'recv retry request, but message not available')
			}
		}
	}

	const handleReceipt = async (node: BinaryNode) => {
		const { attrs, content } = node
		const isLid = attrs.from.includes('lid')
		const isNodeFromMe = areJidsSameUser(
			attrs.participant || attrs.from,
			isLid ? authState.creds.me?.lid : authState.creds.me?.id
		)
		const remoteJid = !isNodeFromMe || isJidGroup(attrs.from) ? attrs.from : attrs.recipient
		const fromMe = !attrs.recipient || ((attrs.type === 'retry' || attrs.type === 'sender') && isNodeFromMe)

		const key: proto.IMessageKey = {
			remoteJid,
			id: '',
			fromMe,
			participant: attrs.participant
		}

		const ids = [attrs.id]
		if (Array.isArray(content)) {
			const items = getBinaryNodeChildren(content[0], 'item')
			ids.push(...items.map(i => i.attrs.id))
		}

		try {
			await receiptMutex.mutex(async () => {
				const status = getStatusFromReceiptType(attrs.type)
				if (
					typeof status !== 'undefined' &&
					// basically, we only want to know when a message from us has been delivered to/read by the other person
					// or another device of ours has read some messages
					(status >= proto.WebMessageInfo.Status.SERVER_ACK || !isNodeFromMe)
				) {
					if (isJidGroup(remoteJid) || isJidStatusBroadcast(remoteJid)) {
						if (attrs.participant) {
							const updateKey: keyof MessageUserReceipt =
								status === proto.WebMessageInfo.Status.DELIVERY_ACK ? 'receiptTimestamp' : 'readTimestamp'
							ev.emit(
								'message-receipt.update',
								ids.map(id => ({
									key: { ...key, id },
									receipt: {
										userJid: jidNormalizedUser(attrs.participant),
										[updateKey]: +attrs.t
									}
								}))
							)
						}
					} else {
						ev.emit(
							'messages.update',
							ids.map(id => ({
								key: { ...key, id },
								update: { status }
							}))
						)
					}
				}

				if (attrs.type === 'retry') {
					// correctly set who is asking for the retry
					key.participant = key.participant || attrs.from
					const retryNode = getBinaryNodeChild(node, 'retry')
					if (willSendMessageAgain(ids[0], key.participant)) {
						if (key.fromMe) {
							try {
								updateSendMessageAgainCount(ids[0], key.participant)
								logger.debug({ attrs, key }, 'recv retry request')
								await sendMessagesAgain(key, ids, retryNode)
							} catch (error: unknown) {
								logger.error(
									{ key, ids, trace: error instanceof Error ? error.stack : 'Unknown error' },
									'error in sending message again'
								)
							}
						} else {
							logger.error({ attrs, key }, 'recv retry for not fromMe message')
						}
					} else {
						logger.info({ attrs, key }, 'will not send message again, as sent too many times')
					}
				}
			})
		} finally {
			await sendMessageAck(node).catch(ackErr => logger.error({ ackErr }, 'failed to ack receipt'))
		}
	}

	const handleNotification = async (node: BinaryNode) => {
		const remoteJid = node.attrs.from

		try {
			await Promise.all([
				notificationMutex.mutex(async () => {
					const msg = await processNotification(node)
					if (msg) {
						const fromMe = areJidsSameUser(node.attrs.participant || remoteJid, authState.creds.me!.id)
						msg.key = {
							remoteJid,
							fromMe,
							participant: node.attrs.participant,
							id: node.attrs.id,
							...(msg.key || {})
						}
						msg.participant ??= node.attrs.participant
						msg.messageTimestamp = +node.attrs.t

						const fullMsg = proto.WebMessageInfo.fromObject(msg)
						await upsertMessage(fullMsg, 'append')
					}
				})
			])
		} catch (error) {
			logger.error({ error, node }, 'error in handling notification')
		} finally {
			await sendMessageAck(node).catch(ackErr => logger.error({ ackErr }, 'failed to ack notification'))
		}
	}

	const handleMessage = async (node: BinaryNode) => {
		const encNode = getBinaryNodeChild(node, 'enc')

		// TODO: temporary fix for crashes and issues resulting of failed msmsg decryption
		if (encNode && encNode.attrs.type === 'msmsg') {
			logger.debug({ key: node.attrs.key }, 'ignored msmsg')
			await sendMessageAck(node)
			return
		}

		let response: string | undefined

		if (getBinaryNodeChild(node, 'unavailable') && !encNode) {
			await sendMessageAck(node)
			const { key } = decodeMessageNode(node, authState.creds.me!.id, authState.creds.me!.lid || '').fullMessage
			response = await requestPlaceholderResend(key)
			if (response === 'RESOLVED') {
				return
			}

			logger.debug('received unavailable message, acked and requested resend from phone')
		} else {
			if (await placeholderResendCache.get(node.attrs.id)) {
				await placeholderResendCache.del(node.attrs.id)
			}
		}

		const {
			fullMessage: msg,
			category,
			author,
			decrypt
		} = decryptMessageNode(node, authState.creds.me!.id, authState.creds.me!.lid || '', signalRepository, logger)

		if (response && msg?.messageStubParameters?.[0] === NO_MESSAGE_FOUND_ERROR_TEXT) {
			msg.messageStubParameters = [NO_MESSAGE_FOUND_ERROR_TEXT, response]
		}

		if (
			msg.message?.protocolMessage?.type === proto.Message.ProtocolMessage.Type.SHARE_PHONE_NUMBER &&
			node.attrs.sender_pn
		) {
			ev.emit('chats.phoneNumberShare', { lid: node.attrs.from, jid: node.attrs.sender_pn })
		}

		let acked = false
		try {
			await messageMutex.mutex(async () => {
				await decrypt()
				// message failed to decrypt
				if (msg.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT && msg.category !== 'peer') {
					if (msg?.messageStubParameters?.[0] === MISSING_KEYS_ERROR_TEXT) {
						acked = true
						return sendMessageAck(node, NACK_REASONS.ParsingError)
					}

					if (msg.messageStubParameters?.[0] === NO_MESSAGE_FOUND_ERROR_TEXT) {
						// Message arrived without encryption (e.g. CTWA ads messages).
						// Check if this is eligible for placeholder resend (matching WA Web filters).
						const unavailableNode = getBinaryNodeChild(node, 'unavailable')
						const unavailableType = unavailableNode?.attrs?.type
						if (
							unavailableType === 'bot_unavailable_fanout' ||
							unavailableType === 'hosted_unavailable_fanout' ||
							unavailableType === 'view_once_unavailable_fanout'
						) {
							logger.debug(
								{ msgId: msg.key.id, unavailableType },
								'skipping placeholder resend for excluded unavailable type'
							)
							acked = true
							return sendMessageAck(node)
						}

						const messageAge = unixTimestampSeconds() - toNumber(msg.messageTimestamp)
						if (messageAge > PLACEHOLDER_MAX_AGE_SECONDS) {
							logger.debug({ msgId: msg.key.id, messageAge }, 'skipping placeholder resend for old message')
							acked = true
							return sendMessageAck(node)
						}

						// Request the real content from the phone via placeholder resend PDO.
						// Upsert the CIPHERTEXT stub as a placeholder (like WA Web's processPlaceholderMsg),
						// and store the requestId in stubParameters[1] so users can correlate
						// with the incoming PDO response event.
						const cleanKey: proto.IMessageKey = {
							remoteJid: msg.key.remoteJid,
							fromMe: msg.key.fromMe,
							id: msg.key.id,
							participant: msg.key.participant
						}
						// Cache the original message metadata so the PDO response handler
						// can preserve key fields (LID details etc.) that the phone may omit
						const msgData: Partial<WAMessage> = {
							key: msg.key,
							messageTimestamp: msg.messageTimestamp,
							pushName: msg.pushName,
							participant: msg.participant,
							verifiedBizName: msg.verifiedBizName
						}
						requestPlaceholderResend(cleanKey, msgData)
							.then(requestId => {
								if (requestId && requestId !== 'RESOLVED') {
									logger.debug({ msgId: msg.key.id, requestId }, 'requested placeholder resend for unavailable message')
									ev.emit('messages.update', [
										{
											key: msg.key,
											update: { messageStubParameters: [NO_MESSAGE_FOUND_ERROR_TEXT, requestId] }
										}
									])
								}
							})
							.catch(err => {
								logger.warn({ err, msgId: msg.key.id }, 'failed to request placeholder resend for unavailable message')
							})
						acked = true
						await sendMessageAck(node)
						// Don't return — fall through to upsertMessage so the stub is emitted
					} else {
						if (isJidStatusBroadcast(msg.key.remoteJid!)) {
							const messageAge = unixTimestampSeconds() - toNumber(msg.messageTimestamp)
							if (messageAge > STATUS_EXPIRY_SECONDS) {
								logger.debug(
									{ msgId: msg.key.id, messageAge, remoteJid: msg.key.remoteJid },
									'skipping retry for expired status message'
								)
								acked = true
								return sendMessageAck(node)
							}
						}

						const errorMessage = msg?.messageStubParameters?.[0] || ''
						const isNoSenderKeyError =
							errorMessage.includes('No SenderKeyRecord') ||
							errorMessage.includes('No session found to decrypt message')
						const isPreKeyError = errorMessage.includes('PreKey')

						logger.debug(`[handleMessage] Attempting retry request for failed decryption`)

						// Handle both pre-key and normal retries in single mutex
						await retryMutex.mutex(async () => {
							try {
								if (!ws.isOpen) {
									logger.debug({ node }, 'Connection closed, skipping retry')
									return
								}

								// Handle pre-key errors with upload and delay
								if (isPreKeyError) {
									logger.info({ error: errorMessage }, 'PreKey error detected, uploading and retrying')

									try {
										logger.debug('Uploading pre-keys for error recovery')
										await uploadPreKeys(5)
										logger.debug('Waiting for server to process new pre-keys')
										await delay(1000)
									} catch (uploadErr) {
										logger.error({ uploadErr }, 'Pre-key upload failed, proceeding with retry anyway')
									}
								}

								await sendRetryRequest(node, !encNode || isNoSenderKeyError)
								if (retryRequestDelayMs) {
									await delay(retryRequestDelayMs)
								}
							} catch (err) {
								logger.error({ err, isPreKeyError }, 'Failed to handle retry, attempting basic retry')
								// Still attempt retry even if pre-key upload failed
								try {
									await sendRetryRequest(node, !encNode || isNoSenderKeyError)
								} catch (retryErr) {
									logger.error({ retryErr }, 'Failed to send retry after error handling')
								}
							}

							acked = true
							await sendMessageAck(node, NACK_REASONS.UnhandledError)
						})
					}
				} else {
					const isNewsletter = isJidNewsletter(msg.key.remoteJid!)

					if (isNewsletter) {
						acked = true
						await sendMessageAck(node)
						logger.debug({ key: msg.key }, 'processed newsletter message without receipts')
					} else {
						// no type in the receipt => message delivered
						let type: MessageReceiptType = undefined
						let participant = msg.key.participant
						if (category === 'peer') {
							// special peer message
							type = 'peer_msg'
						} else if (msg.key.fromMe) {
							// message was sent by us from a different device
							type = 'sender'
							// need to specially handle this case
							if (isJidUser(msg.key.remoteJid!)) {
								participant = author
							}
						} else if (!sendActiveReceipts) {
							type = 'inactive'
						}

						acked = true
						await sendReceipt(msg.key.remoteJid!, participant!, [msg.key.id!], type)

						// send ack for history message
						const isAnyHistoryMsg = getHistoryMsg(msg.message!)
						if (isAnyHistoryMsg) {
							const jid = jidNormalizedUser(msg.key.remoteJid!)
							acked = true
							await sendReceipt(jid, undefined, [msg.key.id!], 'hist_sync')
						}
					}
				}

				cleanMessage(msg, authState.creds.me!.id)

				await upsertMessage(msg, node.attrs.offline ? 'append' : 'notify')
			})
		} catch (error) {
			logger.error({ error, node }, 'error in handling message')
			if (!acked) {
				await sendMessageAck(node, NACK_REASONS.UnhandledError).catch(ackErr =>
					logger.error({ ackErr }, 'failed to ack message after error')
				)
			}
		} finally {
			//await sendMessageAck(node)
		}
	}

	const fetchMessageHistory = async (
		count: number,
		oldestMsgKey: WAMessageKey,
		oldestMsgTimestamp: number | Long
	): Promise<string> => {
		if (!authState.creds.me?.id) {
			throw new Boom('Not authenticated')
		}

		const pdoMessage: proto.Message.IPeerDataOperationRequestMessage = {
			historySyncOnDemandRequest: {
				chatJid: oldestMsgKey.remoteJid,
				oldestMsgFromMe: oldestMsgKey.fromMe,
				oldestMsgId: oldestMsgKey.id,
				oldestMsgTimestampMs: oldestMsgTimestamp,
				onDemandMsgCount: count
			},
			peerDataOperationRequestType: proto.Message.PeerDataOperationRequestType.HISTORY_SYNC_ON_DEMAND
		}

		return sendPeerDataOperationMessage(pdoMessage)
	}

	const requestPlaceholderResend = async (
		messageKey: WAMessageKey,
		msgData?: Partial<WAMessage>
	): Promise<string | undefined> => {
		if (!authState.creds.me?.id) {
			throw new Boom('Not authenticated')
		}

		if (await placeholderResendCache.get(messageKey?.id!)) {
			logger.debug({ messageKey }, 'already requested resend')
			return
		} else {
			await placeholderResendCache.set(messageKey?.id!, msgData || true)
		}

		await delay(2000)

		if (!(await placeholderResendCache.get(messageKey?.id!))) {
			logger.debug({ messageKey }, 'message received while resend requested')
			return 'RESOLVED'
		}

		const pdoMessage = {
			placeholderMessageResendRequest: [
				{
					messageKey
				}
			],
			peerDataOperationRequestType: proto.Message.PeerDataOperationRequestType.PLACEHOLDER_MESSAGE_RESEND
		}

		setTimeout(async () => {
			if (await placeholderResendCache.get(messageKey?.id!)) {
				logger.debug({ messageKey }, 'PDO message without response after 8 seconds. Phone possibly offline')
				await placeholderResendCache.del(messageKey?.id!)
			}
		}, 8_000)

		return sendPeerDataOperationMessage(pdoMessage)
	}

	const handleCall = async (node: BinaryNode) => {
		try {
			const { attrs } = node
			const [infoChild] = getAllBinaryNodeChildren(node)
			const callId = infoChild.attrs['call-id']
			const from = infoChild.attrs.from || infoChild.attrs['call-creator']
			const status = getCallStatusFromNode(infoChild)
			const call: WACallEvent = {
				chatId: attrs.from,
				from,
				id: callId,
				date: new Date(+attrs.t * 1000),
				offline: !!attrs.offline,
				status
			}

			if (status === 'offer') {
				call.isVideo = !!getBinaryNodeChild(infoChild, 'video')
				call.isGroup = infoChild.attrs.type === 'group' || !!infoChild.attrs['group-jid']
				call.groupJid = infoChild.attrs['group-jid']
				callOfferCache.set(call.id, call)
			}

			const existingCall = callOfferCache.get(call.id) as WACallEvent

			// use existing call info to populate this event
			if (existingCall) {
				call.isVideo = existingCall.isVideo
				call.isGroup = existingCall.isGroup
			}

			// delete data once call has ended
			if (status === 'reject' || status === 'accept' || status === 'timeout' || status === 'terminate') {
				callOfferCache.del(call.id)
			}

			ev.emit('call', [call])
		} catch (error) {
			logger.error({ error, node: binaryNodeToString(node) }, 'error in handling call')
		} finally {
			await sendMessageAck(node).catch(ackErr => logger.error({ ackErr }, 'failed to ack call'))
		}
	}

	const handleBadAck = async ({ attrs }: BinaryNode) => {
		const key: WAMessageKey = { remoteJid: attrs.from, fromMe: true, id: attrs.id }

		// WARNING: REFRAIN FROM ENABLING THIS FOR NOW. IT WILL CAUSE A LOOP
		// // current hypothesis is that if pash is sent in the ack
		// // it means -- the message hasn't reached all devices yet
		// // we'll retry sending the message here
		// if(attrs.phash) {
		// 	logger.info({ attrs }, 'received phash in ack, resending message...')
		// 	const msg = await getMessage(key)
		// 	if(msg) {
		// 		await relayMessage(key.remoteJid!, msg, { messageId: key.id!, useUserDevicesCache: false })
		// 	} else {
		// 		logger.warn({ attrs }, 'could not send message again, as it was not found')
		// 	}
		// }

		// error in acknowledgement,
		// device could not display the message
		if (attrs.error) {
			logger.warn({ attrs }, 'received error in ack')
			ev.emit('messages.update', [
				{
					key,
					update: {
						status: WAMessageStatus.ERROR,
						messageStubParameters: [attrs.error]
					}
				}
			])
		}
	}

	/// processes a node with the given function
	/// and adds the task to the existing buffer if we're buffering events
	const processNodeWithBuffer = async <T>(
		node: BinaryNode,
		identifier: string,
		exec: (node: BinaryNode, offline: boolean) => Promise<T>
	) => {
		ev.buffer()
		try {
			await execTask()
		} catch (error) {
			logger.error({ error, identifier }, 'Error processing node with buffer')
			throw error
		} finally {
			ev.flush()
		}

		function execTask() {
			return exec(node, false).catch(err => onUnexpectedError(err, identifier))
		}
	}

	type MessageType = 'message' | 'call' | 'receipt' | 'notification'

	type OfflineNode = {
		type: MessageType
		node: BinaryNode
	}

	const makeOfflineNodeProcessor = () => {
		const nodeProcessorMap: Map<MessageType, (node: BinaryNode) => Promise<void>> = new Map([
			['message', handleMessage],
			['call', handleCall],
			['receipt', handleReceipt],
			['notification', handleNotification]
		])
		const nodes: OfflineNode[] = []
		let isProcessing = false

		// Number of nodes to process before yielding to event loop
		const BATCH_SIZE = 10
		/** Yields control to the event loop to prevent blocking */
		const yieldToEventLoop = (): Promise<void> => {
			return new Promise(resolve => setImmediate(resolve))
		}

		const enqueue = (type: MessageType, node: BinaryNode) => {
			nodes.push({ type, node })

			if (isProcessing) {
				return
			}

			isProcessing = true

			const promise = async () => {
				let processedInBatch = 0

				while (nodes.length && ws.isOpen) {
					const { type, node } = nodes.shift()!

					const nodeProcessor = nodeProcessorMap.get(type)

					if (!nodeProcessor) {
						onUnexpectedError(
							new Error(`unknown offline node type: ${type}`),
							`processing offline node ${type} (unknown type)`
						)
						continue
					}

					await nodeProcessor(node)
					processedInBatch++

					// Yield to event loop after processing a batch
					// This prevents blocking the event loop for too long when there are many offline nodes
					if (processedInBatch >= BATCH_SIZE) {
						processedInBatch = 0
						await yieldToEventLoop()
					}
				}

				isProcessing = false
			}

			promise().catch(error => onUnexpectedError(error, 'processing offline nodes'))
		}

		return { enqueue }
	}

	const offlineNodeProcessor = makeOfflineNodeProcessor()

	const processNode = async (
		type: MessageType,
		node: BinaryNode,
		identifier: string,
		exec: (node: BinaryNode) => Promise<void>
	) => {
		if (type !== 'call') {
			const from = node.attrs.from
			const shouldIgnore = await shouldIgnoreJid(from)

			if (from && from !== S_WHATSAPP_NET && shouldIgnore) {
				await sendMessageAck(node, type === 'message' ? NACK_REASONS.UnhandledError : undefined).catch(ackErr =>
					logger.error({ ackErr }, `failed to ack ignored ${type} node`)
				)
				logger.info({ from, type }, `ignored ${type} node from blocked jid`)
				return
			}
		}

		const isOffline = !!node.attrs.offline

		if (isOffline) {
			offlineNodeProcessor.enqueue(type, node)
		} else {
			await processNodeWithBuffer(node, identifier, exec).catch(error => onUnexpectedError(error, identifier))
		}
	}

	// Handles newsletter notifications
	async function handleNewsletterNotification(node: BinaryNode) {
		const from = node.attrs.from
		const [child] = getAllBinaryNodeChildren(node)
		const author = node.attrs.participant

		logger.info({ from, child }, 'got newsletter notification')

		switch (child.tag) {
			case 'reaction':
				const reactionUpdate = {
					id: from,
					server_id: child.attrs.message_id,
					reaction: {
						code: getBinaryNodeChildString(child, 'reaction'),
						count: 1
					}
				}
				ev.emit('newsletter.reaction', reactionUpdate)
				break

			case 'view':
				const viewUpdate = {
					id: from,
					server_id: child.attrs.message_id,
					count: parseInt(child.content?.toString() || '0', 10)
				}
				ev.emit('newsletter.view', viewUpdate)
				break

			case 'participant':
				const participantUpdate = {
					id: from,
					author,
					user: child.attrs.jid,
					action: child.attrs.action,
					new_role: child.attrs.role
				}
				ev.emit('newsletter-participants.update', participantUpdate)
				break

			case 'update':
				const settingsNode = getBinaryNodeChild(child, 'settings')
				if (settingsNode) {
					const update: Record<string, any> = {}
					const nameNode = getBinaryNodeChild(settingsNode, 'name')
					if (nameNode?.content) update.name = nameNode.content.toString()

					const descriptionNode = getBinaryNodeChild(settingsNode, 'description')
					if (descriptionNode?.content) update.description = descriptionNode.content.toString()

					ev.emit('newsletter-settings.update', {
						id: from,
						update
					})
				}

				break

			case 'message':
				const plaintextNode = getBinaryNodeChild(child, 'plaintext')
				if (plaintextNode?.content) {
					try {
						const contentBuf =
							typeof plaintextNode.content === 'string'
								? Buffer.from(plaintextNode.content, 'binary')
								: Buffer.from(plaintextNode.content as Uint8Array)
						const messageProto = proto.Message.decode(contentBuf)
						const fullMessage = proto.WebMessageInfo.fromObject({
							key: {
								remoteJid: from,
								id: child.attrs.message_id || child.attrs.server_id,
								fromMe: false
							},
							message: messageProto,
							messageTimestamp: +child.attrs.t
						})
						await upsertMessage(fullMessage, 'append')
						logger.info('Processed plaintext newsletter message')
					} catch (error) {
						logger.error({ error }, 'Failed to decode plaintext newsletter message')
					}
				}

				break

			default:
				logger.warn({ node }, 'Unknown newsletter notification')
				break
		}
	}

	// Handles privacy token notifications
	const handlePrivacyTokenNotification = async (node: BinaryNode) => {
		const tokensNode = getBinaryNodeChild(node, 'tokens')
		const from = jidNormalizedUser(node.attrs.from)

		if (!tokensNode) return

		const tokenNodes = getBinaryNodeChildren(tokensNode, 'token')

		for (const tokenNode of tokenNodes) {
			logger.debug({ tokenNodes }, 'got privacy token update')

			const { attrs, content } = tokenNode
			const type = attrs.type
			const timestamp = attrs.t

			console.log('New token node - TCTOKEN', { tokenNode })

			if (type === 'trusted_contact' && content instanceof Buffer) {
				logger.debug(
					{
						from,
						timestamp,
						tcToken: content
					},
					'received trusted contact token'
				)

				await authState.keys.set({
					'tc-token': { [from]: { token: content } }
				})
			}
		}
	}

	async function handleMexNewsletterNotificationNew(node: BinaryNode) {
		const from = node.attrs.from

		const updateContent = getBinaryNodeChild(node, 'update')

		const attrs = updateContent?.attrs

		if (!updateContent || !attrs || !updateContent.content) {
			logger.warn({ node }, 'Invalid mex newsletter notification')
			return
		}

		const json = Buffer.from(updateContent.content as Uint8Array).toString('utf8')

		try {
			const parsedData = JSON.parse(json)
			const payload = parsedData.data as NewsletterEventPayloads

			switch (attrs.op_name) {
				case 'NotificationNewsletterStateChange':
					const payloadOnStateChangeParsed = payload.xwa2_notify_newsletter_on_state_change

					if (payloadOnStateChangeParsed.state.type.toLowerCase() === 'deleted') {
						ev.emit('newsletter.unfollow', {
							id: from,
							role: 'GUEST'
						})
						return
					}

					break
				case 'NotificationNewsletterAdminPromote':
					const payloadPromoteParsed = payload.xwa2_notify_newsletter_admin_promote
					ev.emit('newsletter-participants.update', {
						id: from,
						author: payloadPromoteParsed.actor,
						user: payloadPromoteParsed.user,
						new_role: payloadPromoteParsed.user_new_role,
						action: 'promote'
					})
					break
				case 'NotificationNewsletterAdminDemote':
					const payloadDemoteParsed = payload.xwa2_notify_newsletter_admin_demote

					ev.emit('newsletter-participants.update', {
						id: from,
						author: payloadDemoteParsed.actor,
						user: payloadDemoteParsed.user,
						new_role: payloadDemoteParsed.user_new_role,
						action: 'demote'
					})
					break
				case 'NotificationNewsletterMilestone':
					// idk
					break
				case 'NotificationNewsletterLeave':
					const threadMetadataLeave = payload.xwa2_notify_newsletter_on_leave
					ev.emit('newsletter.unfollow', {
						id: from,
						role: threadMetadataLeave.role
					})
					break
				case 'NotificationNewsletterJoin':
					const threadMetadataJoin = payload.xwa2_notify_newsletter_on_join.thread_metadata

					ev.emit('newsletter.follow', {
						id: from,
						data: threadMetadataJoin
					})

					break

				case 'NotificationNewsletterUpdate':
					const threadMetadata = payload.xwa2_notify_newsletter_on_metadata_update.thread_metadata

					ev.emit('newsletter-settings.update', {
						id: from,
						update: threadMetadata
					})

					break
			}
		} catch (error) {
			logger.error({ node, error }, 'Failed to parse mex newsletter notification')
		}
	}

	// Handles mex newsletter notifications
	async function handleMexNewsletterNotification(node: BinaryNode) {
		const mexNode = getBinaryNodeChild(node, 'mex')
		if (!mexNode?.content) {
			logger.warn({ node }, 'Invalid mex newsletter notification')
			return handleMexNewsletterNotificationNew(node)
		}

		let data: any
		try {
			data = JSON.parse(mexNode.content.toString())
		} catch (error) {
			logger.error({ err: error, node }, 'Failed to parse mex newsletter notification')
			return
		}

		const operation = data?.operation
		const updates = data?.updates

		if (!updates || !operation) {
			logger.warn({ data }, 'Invalid mex newsletter notification content')
			return
		}

		logger.info({ operation, updates }, 'got mex newsletter notification')

		switch (operation) {
			case 'NotificationNewsletterUpdate':
				for (const update of updates) {
					if (update.jid && update.settings && Object.keys(update.settings).length > 0) {
						ev.emit('newsletter-settings.update', {
							id: update.jid,
							update: update.settings
						})
					}
				}

				break

			case 'NotificationNewsletterAdminPromote':
				for (const update of updates) {
					if (update.jid && update.user) {
						ev.emit('newsletter-participants.update', {
							id: update.jid,
							author: node.attrs.from,
							user: update.user,
							new_role: 'ADMIN',
							action: 'promote'
						})
					}
				}

				break

			default:
				logger.info({ operation, data }, 'Unhandled mex newsletter notification')
				break
		}
	}

	// recv a message
	ws.on('CB:message', async (node: BinaryNode) => {
		try {
			await processNode('message', node, 'processing message', handleMessage)
		} catch (error) {
			logger.error({ error, node }, 'error in message handler')
		}
	})

	ws.on('CB:call', async (node: BinaryNode) => {
		try {
			await processNode('call', node, 'handling call', handleCall)
		} catch (error) {
			logger.error({ error, node }, 'error in call handler')
		}
	})

	ws.on('CB:receipt', async node => {
		try {
			await processNode('receipt', node, 'handling receipt', handleReceipt)
		} catch (error) {
			logger.error({ error, node }, 'error in receipt handler')
		}
	})

	ws.on('CB:notification', async (node: BinaryNode) => {
		try {
			await processNode('notification', node, 'handling notification', handleNotification)
		} catch (error) {
			logger.error({ error, node }, 'error in notification handler')
		}
	})
	ws.on('CB:ack,class:message', (node: BinaryNode) => {
		handleBadAck(node).catch(error => onUnexpectedError(error, 'handling bad ack'))
	})

	ev.on('call', ([call]) => {
		// missed call + group call notification message generation
		if (call.status === 'timeout' || (call.status === 'offer' && call.isGroup)) {
			const msg: proto.IWebMessageInfo = {
				key: {
					remoteJid: call.chatId,
					id: call.id,
					fromMe: false
				},
				messageTimestamp: unixTimestampSeconds(call.date)
			}
			if (call.status === 'timeout') {
				if (call.isGroup) {
					msg.messageStubType = call.isVideo
						? WAMessageStubType.CALL_MISSED_GROUP_VIDEO
						: WAMessageStubType.CALL_MISSED_GROUP_VOICE
				} else {
					msg.messageStubType = call.isVideo ? WAMessageStubType.CALL_MISSED_VIDEO : WAMessageStubType.CALL_MISSED_VOICE
				}
			} else {
				msg.message = { call: { callKey: Buffer.from(call.id) } }
			}

			const protoMsg = proto.WebMessageInfo.fromObject(msg)
			upsertMessage(protoMsg, call.offline ? 'append' : 'notify')
		}
	})

	ev.on('connection.update', ({ isOnline }) => {
		if (typeof isOnline !== 'undefined') {
			sendActiveReceipts = isOnline
			logger.trace(`sendActiveReceipts set to "${sendActiveReceipts}"`)
		}
	})

	return {
		...sock,
		sendMessageAck,
		sendRetryRequest,
		rejectCall,
		fetchMessageHistory,
		requestPlaceholderResend
	}
}
