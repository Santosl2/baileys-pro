import { Boom } from '@hapi/boom'
import NodeCache from '@cacheable/node-cache'
import readline from 'readline'
import makeWASocket, { CacheStore, DEFAULT_CONNECTION_CONFIG, DisconnectReason, fetchLatestBaileysVersion, generateMessageIDV2, getAggregateVotesInPollMessage, isJidNewsletter, makeCacheableSignalKeyStore, proto, useMultiFileAuthState, WAMessageContent, WAMessageKey } from '../src'
import P from 'pino'

const logger = P({
  level: "trace",
  transport: {
    targets: [
      {
        target: "pino-pretty", // pretty-print for console
        options: { colorize: true },
        level: "trace",
      },
      {
        target: "pino/file", // raw file output
        options: { destination: './wa-logs.txt' },
        level: "trace",
      },
    ],
  },
})
logger.level = 'trace'

const doReplies = process.argv.includes('--do-reply')
const usePairingCode = process.argv.includes('--use-pairing-code')

// external map to store retry counts of messages when decryption/encryption fails
// keep this out of the socket itself, so as to prevent a message decryption/encryption loop across socket restarts
const msgRetryCounterCache = new NodeCache() as CacheStore

const onDemandMap = new Map<string, string>()

// Read line interface
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const question = (text: string) => new Promise<string>(resolve => rl.question(text, resolve))

function patchMessageBeforeSending(msg: proto.IMessage, jid: string[]): Promise<proto.IMessage> | proto.IMessage {
	//console.log({ jid, msg: JSON.stringify(msg, null, 2) });
	if (msg?.deviceSentMessage?.message?.listMessage) {
		//msg.deviceSentMessage.message.listMessage.listType = proto.Message.ListMessage.ListType.SINGLE_SELECT;
		console.log('ListType in deviceSentMessage is patched:', msg.deviceSentMessage.message.listMessage.listType)
	}

	if (msg?.listMessage) {
		//msg.listMessage.listType = proto.Message.ListMessage.ListType.SINGLE_SELECT;
		console.log('ListType in listMessage is patched:', msg.listMessage.listType)
	}

	const requiresPatch = !!(msg.buttonsMessage || msg.templateMessage || msg.listMessage)
	if (requiresPatch) {
		msg = {
			viewOnceMessage: {
				message: {
					messageContextInfo: {
						deviceListMetadata: {},
						deviceListMetadataVersion: 2
					},
					...msg
				}
			}
		}
	}

	console.log(JSON.stringify(msg, null, 2))
	return msg
}
// start a connection
const startSock = async () => {
	const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info')
	// NOTE: For unit testing purposes only
	if (process.env.ADV_SECRET_KEY) {
		state.creds.advSecretKey = process.env.ADV_SECRET_KEY
	}
	// fetch latest version of WA Web
	const { version, isLatest } = await fetchLatestBaileysVersion()
	logger.debug({version: version.join('.'), isLatest}, `using latest WA version`)

	const sock = makeWASocket({
		// version,
		version: [2, 3000, 1023979355],

		// logger: P({level: 'silent'}),
		logger,
		waWebSocketUrl: process.env.SOCKET_URL ?? DEFAULT_CONNECTION_CONFIG.waWebSocketUrl,
		auth: {
			creds: state.creds,
			/** caching makes the store faster to send/recv messages */
			keys: makeCacheableSignalKeyStore(state.keys, logger)
		},
		msgRetryCounterCache,
		generateHighQualityLinkPreview: true,
		// patchMessageBeforeSending
		// ignore all broadcast messages -- to receive the same
		// comment the line below out
		// shouldIgnoreJid: jid => isJidBroadcast(jid) || isJidNewsletter(jid),
		// implement to handle retries & poll updates
		getMessage
	})


	// Pairing code for Web clients
	if (usePairingCode && !sock.authState.creds.registered) {
		// todo move to QR event
		const phoneNumber = await question('Please enter your phone number:\n')
		const code = await sock.requestPairingCode(phoneNumber)
		console.log(`Pairing code: ${code}`)
	}

	const sendMessageWTyping = async (msg: AnyMessageContent, jid: string) => {
		await sock.presenceSubscribe(jid)
		await delay(500)

		await sock.sendPresenceUpdate('composing', jid)
		await delay(2000)

		await sock.sendPresenceUpdate('paused', jid)

		await sock.sendMessage(jid, msg)
	}

	// the process function lets you process all events that just occurred
	// efficiently in a batch
	sock.ev.process(
		// events is a map for event name => event data
		async events => {
			events['']
			// something about the connection changed
			// maybe it closed, or we received all offline message or connection opened
			if (events['connection.update']) {
				const update = events['connection.update']
				const { connection, lastDisconnect, qr } = update

				console.log('connection update', qr)
				if (connection === 'close') {
					// reconnect if not logged out
					if ((lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut) {
						startSock()
					} else {
						logger.fatal('Connection closed. You are logged out.')
					}
				}

				// WARNING: THIS WILL SEND A WAM EXAMPLE AND THIS IS A ****CAPTURED MESSAGE.****
				// DO NOT ACTUALLY ENABLE THIS UNLESS YOU MODIFIED THE FILE.JSON!!!!!
				// THE ANALYTICS IN THE FILE ARE OLD. DO NOT USE THEM.
				// YOUR APP SHOULD HAVE GLOBALS AND ANALYTICS ACCURATE TO TIME, DATE AND THE SESSION
				// THIS FILE.JSON APPROACH IS JUST AN APPROACH I USED, BE FREE TO DO THIS IN ANOTHER WAY.
				// THE FIRST EVENT CONTAINS THE CONSTANT GLOBALS, EXCEPT THE seqenceNumber(in the event) and commitTime
				// THIS INCLUDES STUFF LIKE ocVersion WHICH IS CRUCIAL FOR THE PREVENTION OF THE WARNING
				const sendWAMExample = false
				if (connection === 'open') {
					const buttons: proto.Message.ButtonsMessage.IButton[] = [
						{ buttonId: 'id1', buttonText: { displayText: 'Teste' }, type: 1 },
						{ buttonId: 'id2', buttonText: { displayText: 'Teste 2' }, type: 1 }
					]

					const buttonMessage = {
						text: 'A prova que funciona',
						footer: 'Teste mostrando o funcionamento de envio de mensagens',
						buttons,
						headerType: 1,
						viewOnce: true
					}

				

					// await sock.sendMessage('553185702237@s.whatsapp.net', buttonMessage)
				}

				if (connection === 'open' && sendWAMExample) {
					/// sending WAM EXAMPLE
					
					const {
						header: { wamVersion, eventSequenceNumber },
						events
					} = JSON.parse(await fs.promises.readFile('./boot_analytics_test.json', 'utf-8'))

					const binaryInfo = new BinaryInfo({
						protocolVersion: wamVersion,
						sequence: eventSequenceNumber,
						events: events
					})

					const buffer = encodeWAM(binaryInfo)

					const result = await sock.sendWAMBuffer(buffer)
					console.log(result)
				}
			}

			sock.ws.on('CB:message', data => {
				// console.log('CB:message', JSON.stringify(data, null, 2))
			})

			// credentials updated -- save them
			if (events['creds.update']) {
				await saveCreds()
				logger.debug({}, 'creds save triggered')
			}

			if (events['labels.association']) {
				console.log(events['labels.association'])
			}

			if (events['labels.edit']) {
				console.log(events['labels.edit'])
			}

			if (events.call) {
				console.log('recv call event', events.call)
			}

			// history received
			if (events['messaging-history.set']) {
				const { chats, contacts, messages, isLatest, progress, syncType } = events['messaging-history.set']
				if (syncType === proto.HistorySync.HistorySyncType.ON_DEMAND) {
					logger.debug(messages, 'received on-demand history sync')
				}
				console.log(
					`recv ${chats.length} chats, ${contacts.length} contacts, ${messages.length} msgs (is latest: ${isLatest}, progress: ${progress}%), type: ${syncType}`
				)
			}

			// received a new message
      if (events['messages.upsert']) {
        const upsert = events['messages.upsert']
        logger.debug(upsert, 'messages.upsert fired')

        if (!!upsert.requestId) {
          logger.debug(upsert, 'placeholder request message received')
        }



        if (upsert.type === 'notify') {
          for (const msg of upsert.messages) {
            if (msg.message?.conversation || msg.message?.extendedTextMessage?.text) {
              const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text
              if (text == "requestPlaceholder" && !upsert.requestId) {
                const messageId = await sock.requestPlaceholderResend(msg.key)
								logger.debug({ id: messageId }, 'requested placeholder resync')
              }

              // go to an old chat and send this
              if (text == "onDemandHistSync") {
                const messageId = await sock.fetchMessageHistory(50, msg.key, msg.messageTimestamp!)
                logger.debug({ id: messageId }, 'requested on-demand history resync')
              }

              if (!msg.key.fromMe && doReplies && !isJidNewsletter(msg.key?.remoteJid!)) {
              	const id = generateMessageIDV2(sock.user?.id)
              	logger.debug({id, orig_id: msg.key.id }, 'replying to message')
                await sock.sendMessage(msg.key.remoteJid!, { text: 'pong '+msg.key.id }, {messageId: id })
              }
            }
          }
        }
      }

			// messages updated like status delivered, message deleted etc.
			if (events['messages.update']) {
				console.log(JSON.stringify(events['messages.update'], undefined, 2))

				for (const { key, update } of events['messages.update']) {
					if (update.pollUpdates) {
						const pollCreation: proto.IMessage = {} // get the poll creation message somehow
						if (pollCreation) {
							console.log(
								'got poll update, aggregation: ',
								getAggregateVotesInPollMessage({
									message: pollCreation,
									pollUpdates: update.pollUpdates
								})
							)
						}
					}
				}
			}

			if (events['message-receipt.update']) {
				console.log(events['message-receipt.update'])
			}

			if (events['messages.reaction']) {
				console.log(events['messages.reaction'])
			}

			if (events['presence.update']) {
				console.log(events['presence.update'])
			}

			if (events['chats.update']) {
				console.log(events['chats.update'])
			}

			if (events['contacts.update']) {
				for (const contact of events['contacts.update']) {
					if (typeof contact.imgUrl !== 'undefined') {
						const newUrl = contact.imgUrl === null ? null : await sock!.profilePictureUrl(contact.id!).catch(() => null)
						console.log(`contact ${contact.id} has a new profile pic: ${newUrl}`)
					}
				}
			}

			if (events['chats.delete']) {
				console.log('chats deleted ', events['chats.delete'])
			}
		}
	)

	return sock

	async function getMessage(key: WAMessageKey): Promise<WAMessageContent | undefined> {
		// Implement a way to retreive messages that were upserted from messages.upsert
		// up to you

		// only if store is present
		return proto.Message.create({ conversation: 'test' })
	}
}

startSock()
