import { Boom } from '@hapi/boom'
import NodeCache from '@cacheable/node-cache'
import readline from 'readline'
import makeWASocket, {
	AnyMessageContent,
	BinaryInfo,
	delay,
	DisconnectReason,
	encodeWAM,
	fetchLatestBaileysVersion,
	getAggregateVotesInPollMessage,
	makeCacheableSignalKeyStore,
	proto,
	useMultiFileAuthState,
	WANativeFlowButtonEnum,
	WAPaymentStatusEnum,
	WAPaymentOrderStatusEnum,
	WAProductOrderTypeEnum,
	WAInteractiveMessagesNativeFlowName,
	WAPixTypes,
	fetchLatestWaWebVersion
} from '../src'
//import MAIN_LOGGER from '../src/Utils/logger'
import fs from 'fs'
import P from 'pino'
import http from 'http'
import { appendFile } from 'fs/promises'
import { Mutex } from 'async-mutex'

let bot: ReturnType<typeof makeWASocket> | undefined
const logger = P({ timestamp: () => `,"time":"${new Date().toJSON()}"` }, P.destination('./wa-logs.txt'))
logger.level = 'info'

const usePairingCode = process.argv.includes('--use-pairing-code')

// external map to store retry counts of messages when decryption/encryption fails
// keep this out of the socket itself, so as to prevent a message decryption/encryption loop across socket restarts
const msgRetryCounterCache = new NodeCache()

// Read line interface
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const question = (text: string) => new Promise<string>(resolve => rl.question(text, resolve))

const mutex = new Mutex()
// start a connection
const startSock = async () => {
	const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info')

	const { version, isLatest } = await fetchLatestWaWebVersion({})
	console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`)

	const sock = makeWASocket({
		version,
		// logger: P({ level: 'silent' }),
		logger,
		// logger: P({ level: 'info' }),
		auth: {
			creds: state.creds,
			/** caching makes the store faster to send/recv messages */
			keys: makeCacheableSignalKeyStore(state.keys, logger)
		},
		msgRetryCounterCache,
		generateHighQualityLinkPreview: true
	})

	// Pairing code for Web clients
	if (usePairingCode && !sock.authState.creds.registered) {
		// todo move to QR event
		const phoneNumber = await question('Please enter your phone number:\n')
		const code = await sock.requestPairingCode(phoneNumber)
		console.log(`Pairing code: ${code}`)
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

				if (connection === 'open') {
					bot = sock // for easy access in console
				}
			}


			// credentials updated -- save them
			if (events['creds.update']) {
				await saveCreds()
			}

			if (events['labels.association']) {
				//	console.log(events['labels.association'])
			}

			if (events['labels.edit']) {
				//	console.log(events['labels.edit'])
			}

			if (events.call) {
				//console.log('recv call event', events.call)
			}

			// received a new message
			if (events['messages.upsert']) {
				const upsert = events['messages.upsert']
				console.log('recv messages.upsert', JSON.stringify(upsert, undefined, 2))

				if (upsert.type === 'notify') {
					for (const msg of upsert.messages) {
						if (msg.message?.conversation?.startsWith('!')) {
							const command = msg.message.conversation.slice(1).trim().toLowerCase()
							//

							if (command === 'resend') {
								const j = '120363401876317584@g.us'
								await sock.presenceSubscribe(j)
								await sock.sendPresenceUpdate('composing', j)
								await delay(1000)
								await sock.sendPresenceUpdate('paused', j)
								await sock.sendMessage(j, {
									image: {
										url: 'https://m.media-amazon.com/images/I/415W9dedoGL.jpg'
									},
									caption: `*SUPER PROMOÇÃO* 😮‍💨

🎁 Supercoffee Lingua de Gato - Economic Size (380g) - Caffeine Army

~De: N/A~
✅ *POR:* R$ 197,80

Compre aqui: https://amzn.to/4miOyNJ`
								})
							}
						}
					}
				}

				// messages updated like status delivered, message deleted etc.
				if (events['messages.update']) {
					// console.log(JSON.stringify(events['messages.update'], undefined, 2))

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
					//console.log(events['message-receipt.update'])
				}

				if (events['messages.reaction']) {
					//	console.log(events['messages.reaction'])
				}

				if (events['presence.update']) {
					//console.log(events['presence.update'])
				}

				if (events['chats.update']) {
					//console.log(events['chats.update'])
				}

				if (events['contacts.update']) {
					for (const contact of events['contacts.update']) {
						if (typeof contact.imgUrl !== 'undefined') {
							const newUrl =
								contact.imgUrl === null ? null : await sock!.profilePictureUrl(contact.id!).catch(() => null)
							//console.log(`contact ${contact.id} has a new profile pic: ${newUrl}`)
						}
					}
				}

				if (events['chats.delete']) {
					//	console.log('chats deleted ', events['chats.delete'])
				}

				if (events['messaging-history.set']) {
					//console.log('messaging-history.set', events['messaging-history.set'])
				}
			}
		}
	)

	return sock
}

startSock()
const server = http.createServer(async (req, res) => {
	if (req.method === 'POST' && req.url === '/logout') {
		let body = ''
		req.on('data', chunk => {
			body += chunk.toString()
		})

		req.on('end', async () => {
			try {
				

				await bot!.logout('idk')
				res.writeHead(200, { 'Content-Type': 'application/json' })
				res.end(JSON.stringify({ success: true }))
			} catch (error) {
				res.writeHead(500, { 'Content-Type': 'application/json' })
				res.end(JSON.stringify({ error: 'Failed to send message', details: error.message }))
			}
		})
	}else
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