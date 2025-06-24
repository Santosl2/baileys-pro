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
	useMultiFileAuthState
} from '../src'
//import MAIN_LOGGER from '../src/Utils/logger'
import fs from 'fs'
import P from 'pino'

const logger = P({ timestamp: () => `,"time":"${new Date().toJSON()}"` }, P.destination('./wa-logs.txt'))
logger.level = 'trace'

const usePairingCode = process.argv.includes('--use-pairing-code')

// external map to store retry counts of messages when decryption/encryption fails
// keep this out of the socket itself, so as to prevent a message decryption/encryption loop across socket restarts
const msgRetryCounterCache = new NodeCache()

// Read line interface
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const question = (text: string) => new Promise<string>(resolve => rl.question(text, resolve))

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
		generateHighQualityLinkPreview: true
		// patchMessageBeforeSending
		// ignore all broadcast messages -- to receive the same
		// comment the line below out
		// shouldIgnoreJid: jid => isJidBroadcast(jid) || isJidNewsletter(jid),
		// implement to handle retries & poll updates
		// getMessage,
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

				// WARNING: THIS WILL SEND A WAM EXAMPLE AND THIS IS A ****CAPTURED MESSAGE.****
				// DO NOT ACTUALLY ENABLE THIS UNLESS YOU MODIFIED THE FILE.JSON!!!!!
				// THE ANALYTICS IN THE FILE ARE OLD. DO NOT USE THEM.
				// YOUR APP SHOULD HAVE GLOBALS AND ANALYTICS ACCURATE TO TIME, DATE AND THE SESSION
				// THIS FILE.JSON APPROACH IS JUST AN APPROACH I USED, BE FREE TO DO THIS IN ANOTHER WAY.
				// THE FIRST EVENT CONTAINS THE CONSTANT GLOBALS, EXCEPT THE seqenceNumber(in the event) and commitTime
				// THIS INCLUDES STUFF LIKE ocVersion WHICH IS CRUCIAL FOR THE PREVENTION OF THE WARNING
				const sendWAMExample = false
				if (connection === 'open') {
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
				// Usado para debugar novas features
				//	console.log('CB:message', JSON.stringify(data, null, 2))
			})

			async function sendOtp() {
				await sock.sendMessage('553185702237@s.whatsapp.net', {
					text: 'Seu código de verificação é: 123',
					interactiveButtons: [
						{
							name: 'cta_copy',
							buttonParamsJson: '{"fix":true,"display_text":"Copiar código","copy_code":"123"}'
						}
					]
				})

				// Jeito na marra
				// await sock.relayMessage(
				// 	'553185702237@s.whatsapp.net',
				// 	{
				// 		interactiveMessage: {
				// 			body: {
				// 				text: 'Seu código de verificação pode ser copiado abaixo:'
				// 			},
				// 			nativeFlowMessage: {
				// 				buttons: [
				// 					{
				// 						name: 'cta_copy',
				// 						buttonParamsJson: '{"fix":true,"display_text":"Copiar código","copy_code":"123"}'
				// 					}
				// 				]
				// 			}
				// 		}
				// 	},
				// 	{
				// 		additionalNodes: [
				// 			{
				// 				tag: 'biz',
				// 				attrs: {},
				// 				content: [
				// 					{
				// 						tag: 'interactive',
				// 						attrs: {
				// 							type: 'native_flow'
				// 						},
				// 						content: [
				// 							{
				// 								tag: 'native_flow',
				// 								attrs: {
				// 									v: '2',
				// 									name: 'mixed'
				// 								}
				// 							}
				// 						]
				// 					}
				// 				]
				// 			}
				// 		]
				// 	}
				// )
			}

			// Funcionando
			async function sendList() {
				await sock.sendMessage('553185702237@s.whatsapp.net', {
					text: `_Enviada por uma conta TESTE *gratuita!*_

*Sua mensagem abaixo:* 👇
Selecione e melhor opção:`,
					buttonText: 'Abrir lista de opções',
					title: 'Selecione uma opção',
					footer: 'Selecione uma opção',
					listType: 1,
					sections: [
						{
							rows: [
								{
									title: 'Z-API',
									description: 'Z-API Asas para sua imaginação',
									rowId: 'ListV3:1'
								},
								{
									title: 'Outros',
									description: 'Não funcionam',
									rowId: 'ListV3:2'
								}
							],
							title: 'Opções disponíveis'
						}
					]
				})
				// 				await sock.relayMessage(
				// 					'553185702237@s.whatsapp.net',
				// 					{
				// 						listMessage: {
				// 							description: `_Enviada por uma conta TESTE *gratuita!*_

				// *Sua mensagem abaixo:* 👇
				// Selecione e melhor opção:`,
				// 							buttonText: 'Abrir lista de opções',
				// 							listType: 1,
				// 							sections: [
				// 								{
				// 									rows: [
				// 										{
				// 											title: 'Z-API',
				// 											description: 'Z-API Asas para sua imaginação',
				// 											rowId: 'ListV3:1'
				// 										},
				// 										{
				// 											title: 'Outros',
				// 											description: 'Não funcionam',
				// 											rowId: 'ListV3:2'
				// 										}
				// 									],
				// 									title: 'Opções disponíveis'
				// 								}
				// 							]
				// 						}
				// 					},
				// 					{
				// 						additionalNodes: [
				// 							{
				// 								tag: 'biz',
				// 								attrs: {},
				// 								content: [
				// 									{
				// 										tag: 'list',
				// 										attrs: {
				// 											type: 'product_list',
				// 											v: '2'
				// 										}
				// 									}
				// 								]
				// 							}
				// 						]
				// 					}
				// 				)
			}

			// Funcionando
			async function sendPix() {
				await sock.relayMessage(
					'553185702237@s.whatsapp.net',
					{
						interactiveMessage: {
							nativeFlowMessage: {
								buttons: [
									{
										name: 'payment_info',
										buttonParamsJson:
											'{"currency":"BRL","total_amount":{"value":12,"offset":100},"reference_id":"4SE1828Q8SA","type":"physical-goods","order":{"status":"pending","subtotal":{"value":0,"offset":100},"order_type":"ORDER","items":[{"name":"","amount":{"value":0,"offset":100},"quantity":0,"sale_amount":{"value":0,"offset":100}}]},"payment_settings":[{"type":"pix_static_code","pix_static_code":{"merchant_name":"Pix","key":"Chave PIX","key_type":"CPF"}}]}'
									}
								],
								messageVersion: 1
							}
						}
					},
					{
						additionalNodes: [
							{
								tag: 'biz',
								attrs: {},
								content: [
									{
										tag: 'interactive',
										attrs: {
											type: 'native_flow',
											v: '1'
										},
										content: [
											{
												tag: 'native_flow',
												attrs: {
													name: 'payment_info'
												}
											}
										]
									}
								]
							}
						]
					}
				)
			}

			// Funcionando
			async function sendWithMultipleButtons() {
				await sock.sendMessage('553185702237@s.whatsapp.net', {
					text: 'f',
					footer: 'se quiser vincular um rodapé',
					title: 'se quiser vincular um título',
					interactiveButtons: [
						{
							name: 'cta_call',
							buttonParamsJson: '{"fix":true,"display_text":"Fale conosco","phone_number":"+5531985702237"}'
						},
						{
							name: 'cta_url',
							buttonParamsJson:
								'{"fix":true,"display_text":"Visite nosso site","url":"https://mfilype.dev","merchant_url":"https://mfilype.dev"}'
						}
					]
				})
				// 			await sock.relayMessage(
				// 				'553185702237@s.whatsapp.net',
				// 				{
				// 					interactiveMessage: {
				// 						header: {
				// 							title: 'se quiser vincular um título'
				// 						},
				// 						body: {
				// 							text: `

				// *Sua mensagem abaixo:* 👇
				// mensagem`
				// 						},
				// 						footer: {
				// 							text: 'se quiser vincular um rodapé'
				// 						},
				// 						nativeFlowMessage: {
				// 							buttons: [
				// 								{
				// 									name: 'cta_call',
				// 									buttonParamsJson: '{"fix":true,"display_text":"Fale conosco","phone_number":"+5531985702237"}'
				// 								},
				// 								{
				// 									name: 'cta_url',
				// 									buttonParamsJson:
				// 										'{"fix":true,"display_text":"Visite nosso site","url":"https://mfilype.dev","merchant_url":"https://mfilype.dev"}'
				// 								}
				// 							]
				// 						}
				// 					}
				// 				},
				// 				{
				// 					additionalNodes: [
				// 						{
				// 							tag: 'biz',
				// 							attrs: {},
				// 							content: [
				// 								{
				// 									tag: 'interactive',
				// 									attrs: {
				// 										type: 'native_flow'
				// 									},
				// 									content: [
				// 										{
				// 											tag: 'native_flow',
				// 											attrs: {
				// 												v: '2',
				// 												name: 'mixed'
				// 											}
				// 										}
				// 									]
				// 								}
				// 							]
				// 						}
				// 					]
				// 				}
				// 			)
			}

			// Funcionando
			async function sendWithBasicButtons() {
				const buttons: proto.Message.ButtonsMessage.IButton[] = [
					{ buttonId: 'id1', buttonText: { displayText: 'Teste' }, type: 1 },
					{ buttonId: 'id2', buttonText: { displayText: 'Teste 2' }, type: 1 }
				]

				const buttonMessage = {
					text: 'A prova que funciona',
					footer: 'Teste mostrando o funcionamento de envio de mensagens',
					buttons,
					headerType: 1
					// viewOnce: true
				}

				await sock.sendMessage('553185702237@s.whatsapp.net', buttonMessage)
			}

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

			// received a new message
			if (events['messages.upsert']) {
				const upsert = events['messages.upsert']

				if (upsert.type === 'notify') {
					for (const msg of upsert.messages) {
						if (msg.key.fromMe) {
							console.log('is own message')
							if (msg.message?.conversation?.startsWith('!')) {
								await Promise.all([sendOtp(), sendWithMultipleButtons()])
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
}

startSock()
