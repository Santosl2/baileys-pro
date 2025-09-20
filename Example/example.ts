import { Boom } from '@hapi/boom'
import NodeCache from '@cacheable/node-cache'
import readline from 'readline'
import makeWASocket, {
	AnyMessageContent,
	BinaryInfo,
	BinaryNode,
	delay,
	DisconnectReason,
	downloadAndProcessHistorySyncNotification,
	encodeWAM,
	fetchLatestBaileysVersion,
	getAggregateVotesInPollMessage,
	getHistoryMsg,
	isJidBroadcast,
	isJidNewsletter,
	makeCacheableSignalKeyStore,
	proto,
	useMultiFileAuthState,
	WAMessageContent,
	WAMessageKey
} from '../src'
//import MAIN_LOGGER from '../src/Utils/logger'
import open from 'open'
import fs from 'fs'
import P from 'pino'
import { appendFile } from 'fs/promises'
import { Mutex } from 'async-mutex'

const logger = P({ timestamp: () => `,"time":"${new Date().toJSON()}"` }, P.destination('./wa-logs.txt'))
logger.level = 'trace'
const mutex = new Mutex()
import http from 'http'

let bot: ReturnType<typeof makeWASocket> | undefined

const doReplies = process.argv.includes('--do-reply')
const usePairingCode = process.argv.includes('--use-pairing-code')

// external map to store retry counts of messages when decryption/encryption fails
// keep this out of the socket itself, so as to prevent a message decryption/encryption loop across socket restarts
const msgRetryCounterCache = new NodeCache()

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
	// fetch latest version of WA Web
	const { version, isLatest } = await fetchLatestBaileysVersion()
	console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`)

	const sock = makeWASocket({
		// version,
		version: [2, 3000, 1023979355],

		// logger: P({level: 'silent'}),
		logger,
		// logger: P({ level: 'debug' }),
		printQRInTerminal: !usePairingCode,
		
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
		// getMessage,
		shouldSyncHistoryMessage: jid => false,
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
						console.log('Connection closed. You are logged out.')
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
					bot = sock // for easy access in console
// 	const mockReceiptNode: BinaryNode = {
// 	tag: 'receipt',
// 	attrs: {
// 		id: 'ABC12345DEF',
// 		from: '12001234567@whatsapp.net',
// 		participant: '12007654321@whatsapp.net',
// 		type: 'retry',
// 		t: `${Math.floor(Date.now() / 1000)}`,
// 		// recipient: 'me@whatsapp.net'
// 	},
// 	content: [
// 		{
// 			tag: 'list',
// 			attrs: {},
// 			content: [
// 				{
// 					tag: 'item',
// 					attrs: { id: 'MSGID1' },
// 					content: []
// 				},
// 				{
// 					tag: 'item',
// 					attrs: { id: 'MSGID2' },
// 					content: []
// 				}
// 			]
// 		},
// 		{
// 			tag: 'retry',
// 			attrs: {
// 				count: '1',
// 				id: 'ABC12345DEF',
// 				t: `${Math.floor(Date.now() / 1000)}`,
// 				v: '1',
// 				phash: 'prekey-hash',
// 				recvTimestamp: `${Date.now()}`,
// 				// exclusivos de mensagens E2E com cifragem
// 				retryId: 'retry-uuid-001',
// 				epoch: '1',
// 				skey: 'symmetric-key',
// 				enc: 'encrypted-payload',
// 				version: '2'
// 			},
// 			content: []
// 		},
// 		{
// 			tag: 'registration',
// 			attrs: {
// 				id: 'device-registration-id'
// 			},
// 			content: []
// 		}
// 	]
// }


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

		sock.ws.on('frame', async data => {
						const line = `[${new Date().toISOString()}] ${JSON.stringify(data, null, 2)}\n`
						await mutex.runExclusive(() => appendFile('errors.txt', line, { encoding: 'utf8' }))
					})

			// credentials updated -- save them
			if (events['creds.update']) {
				await saveCreds()
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
					console.log('received on-demand history sync, messages=', messages)
				}
				console.log(
					`recv ${chats.length} chats, ${contacts.length} contacts, ${messages.length} msgs (is latest: ${isLatest}, progress: ${progress}%), type: ${syncType}`
				)
			}

			// received a new message
			if (events['messages.upsert']) {
				const upsert = events['messages.upsert']
				console.log('recv messages.upsert', JSON.stringify(upsert, undefined, 2))
				

				if (upsert.type === 'notify') {
					for (const msg of upsert.messages) {
						if(msg.key.fromMe){
						

					// Send OTP 
// 					await sock.relayMessage('553185702237@s.whatsapp.net', {
// 						interactiveMessage: {
// 							body: {
// 								text: 'List Message Body'
// 							},
// 							nativeFlowMessage: {
// 								buttons: [
//           {
//             name: "cta_copy",
//             buttonParamsJson: "{\"fix\":true,\"display_text\":\"Copiar código\",\"copy_code\":\"123\"}",
//           },
//         ],
// 							}
// 						}
// 					}, {
// 						additionalNodes: [{
//   "tag": "biz",
//   "attrs": {},
//   "content": [
//     {
//       "tag": "interactive",
//       "attrs": {
//         "type": "native_flow"
//       },
//       "content": [
//         {
//           "tag": "native_flow",
//           "attrs": {
//             "v": "2",
//             "name": "mixed"
//           }
//         }
//       ]
//     }
//   ]
// }
// ]
// 					})

						}
						//TODO: More built-in implementation of this
						/* if (
							msg.message?.protocolMessage?.type ===
							proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION
						  ) {
							const historySyncNotification = getHistoryMsg(msg.message)
							if (
							  historySyncNotification?.syncType ==
							  proto.HistorySync.HistorySyncType.ON_DEMAND
							) {
							  const { messages } =
								await downloadAndProcessHistorySyncNotification(
								  historySyncNotification,
								  {}
								)


								const chatId = onDemandMap.get(
									historySyncNotification!.peerDataRequestSessionId!
								)

								console.log(messages)

							  onDemandMap.delete(
								historySyncNotification!.peerDataRequestSessionId!
							  )

							  /*
								// 50 messages is the limit imposed by whatsapp
								//TODO: Add ratelimit of 7200 seconds
								//TODO: Max retries 10
								const messageId = await sock.fetchMessageHistory(
									50,
									oldestMessageKey,
									oldestMessageTimestamp
								)
								onDemandMap.set(messageId, chatId)
							}
						  } */

						if (msg.message?.conversation || msg.message?.extendedTextMessage?.text) {
							const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text
							if (text == 'requestPlaceholder' && !upsert.requestId) {
								const messageId = await sock.requestPlaceholderResend(msg.key)
							} else if (upsert.requestId) {
							}

							// go to an old chat and send this
							if (text == 'onDemandHistSync') {
								const messageId = await sock.fetchMessageHistory(50, msg.key, msg.messageTimestamp!)
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
				console.log('recv chats.update', events['chats.update'])
			}


			if (events['chats.upsert']) {
				console.log('recv chats.upsert', events['chats.upsert'])
			}

			if (events['groups.update']) {
				console.log('recv groups.update', events['groups.update'])
			}

			if (events['group-participants.update']) {
				console.log('recv group-participants.update', events['group-participants.update'])
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

		console.log('getMessage', key)
		// only if store is present
		return proto.Message.fromObject({})
	}
}

startSock()


const server = http.createServer(async (req, res) => {
	if (req.method === 'POST' && req.url === '/send-message') {
		let body = ''
		req.on('data', chunk => {
			body += chunk.toString()
		})

		req.on('end', async () => {
			try {
				const { jid, message } = JSON.parse(body)

				if (!jid || !message) {
					res.writeHead(400, { 'Content-Type': 'application/json' })
					res.end(JSON.stringify({ error: 'Missing jid or message in request body' }))
					return
				}

				await bot!.sendMessage(jid, { text: message })
				res.writeHead(200, { 'Content-Type': 'application/json' })
				res.end(JSON.stringify({ success: true }))
			} catch (error) {
				res.writeHead(500, { 'Content-Type': 'application/json' })
				res.end(JSON.stringify({ error: 'Failed to send message', details: error.message }))
			}
		})
	} else {
		res.writeHead(404, { 'Content-Type': 'application/json' })
		res.end(JSON.stringify({ error: 'Not Found' }))
	}
})

server.listen(3100, () => {
	console.log('HTTP server running on http://localhost:3100')
})