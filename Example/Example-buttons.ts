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
	const { version, isLatest } = await fetchLatestWaWebVersion({})
	console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`)

	const sock = makeWASocket({
		version,

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

				if (connection === 'open') {
				}
			}

			sock.ws.on('CB:message', data => {
				// Usado para debugar novas features
				// console.log('CB:message', JSON.stringify(data, null, 2))
			})

			async function sendOtp() {
				await sock.sendMessage('553185702237@s.whatsapp.net', {
					text: 'Seu código de verificação é: 123',
					interactiveButtons: [
						{
							name: WANativeFlowButtonEnum.CTA_COPY,
							buttonParamsJson: '{"fix":true,"display_text":"Copiar código","copy_code":"123"}'
						}
					]
				})
			}

			// Funcionando
			async function sendList() {
				await sock.sendMessage('553185702237@s.whatsapp.net', {
					text: `_Fala comigo Lucas!*_

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
									title: 'Batata',
									description: 'Batata frita é uma delícia',
									rowId: 'ListV3:1'
								},
								{
									title: 'Outros',
									description: 'Outros são ruins',
									rowId: 'ListV3:2'
								}
							],
							title: 'Opções disponíveis'
						}
					]
				})
			}

			// Todo: Ainda em desenvolvimento
			async function sendCarousel() {
				await sock.sendMessage('553185702237@s.whatsapp.net', {
					text: 'f',
					cards: [
						{
							buttons: [
								{
									name: 'cta_call',
									buttonParamsJson: '{"fix":true,"display_text":"Fale conosco","phone_number":"+5531985702237"}'
								}
							],
							image: {
								url: 'https://i.redd.it/i-got-bored-so-i-decided-to-draw-a-random-image-on-the-v0-4ig97vv85vjb1.png?width=1280&format=png&auto=webp&s=7177756d1f393b6e093596d06e1ba539f723264b'
							}
						}
					]
				})
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
										name: WANativeFlowButtonEnum.PAYMENT_INFO,
										buttonParamsJson: JSON.stringify({
											currency: 'BRL',
											total_amount: {
												value: 12,
												offset: 100
											},
											reference_id: '4SE1828Q8SA',
											type: 'physical-goods',
											order: {
												status: 'pending',
												subtotal: {
													value: 0,
													offset: 100
												},
												order_type: 'ORDER',
												items: [
													{
														name: '',
														amount: {
															value: 0,
															offset: 100
														},
														quantity: 0,
														sale_amount: {
															value: 0,
															offset: 100
														}
													}
												]
											},
											payment_settings: [
												{
													type: 'pix_static_code', // pix_DYNAMIC_code
													pix_static_code: {
														merchant_name: 'Matheus Filype',
														key: 'mfilype2019@gmail.com', // Chave PIX,
														key_type: WAPixTypes.EMAIL
													}
												}
											]
										})
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
							name: WANativeFlowButtonEnum.CTA_CALL,
							buttonParamsJson: '{"fix":true,"display_text":"Fale conosco","phone_number":"+5531985702237"}'
						},
						{
							name: WANativeFlowButtonEnum.CTA_URL,
							buttonParamsJson:
								'{"fix":true,"display_text":"Visite nosso site","url":"https://mfilype.dev","merchant_url":"https://mfilype.dev"}'
						}
					]
				})
			}

			async function sendWithMultipleButtonsWithImage() {
				await sock.sendMessage('553185702237@s.whatsapp.net', {
					caption: 'f',
					footer: 'se quiser vincular um rodapé',
					title: 'se quiser vincular um título',
					media: true,
					subtitle: 'se quiser vincular um subtítulo',
					image: {
						url: 'https://cdn.pixabay.com/photo/2024/05/14/11/37/tv-8760950_1280.png'
					},
					interactiveButtons: [
						{
							name: WANativeFlowButtonEnum.CTA_CALL,
							buttonParamsJson: JSON.stringify({
								fix: true,
								display_text: 'Fale conosco',
								phone_number: '+5531985702237'
							})
						},
						{
							name: WANativeFlowButtonEnum.CTA_URL,
							buttonParamsJson: JSON.stringify({
								fix: true,
								display_text: 'Visite nosso site',
								url: 'https://mfilype.dev',
								merchant_url: 'https://mfilype.dev'
							})
						}
					]
				})
			}

			// Funcionando
			async function sendWithBasicButtons() {
				await sock.sendMessage('553185702237@s.whatsapp.net', {
					text: 'Teste do Matheus',
					footer: 'se quiser vincular um rodapé',

					interactiveButtons: [
						{
							name: WANativeFlowButtonEnum.REPLY,
							buttonParamsJson: JSON.stringify({
								fix: true,
								display_text: 'Fale conosco',
								id: 'abc'
							})
						},
						{
							name: WANativeFlowButtonEnum.REPLY,
							buttonParamsJson: JSON.stringify({
								fix: true,
								display_text: 'Fale conoscoc',
								id: 'abcd'
							})
						}
					]
				})
			}

			// Ainda em desenvolvimento
			// Botoes de criacao de pedido
			async function sendButtonCode1() {
				await sock.relayMessage(
					'553195702237',
					{
						interactiveMessage: {
							nativeFlowMessage: {
								buttons: [
									{
										name: WANativeFlowButtonEnum.REVIEW_AND_PAY,
										buttonParamsJson: JSON.stringify({
											order: {
												items: [
													{
														amount: {
															value: 100000,
															offset: 1000
														},
														isCustomItem: false,
														isQuantitySet: true,
														name: 'Nome do produto',
														quantity: 2,
														// Ver como gerar
														retailer_id: '8502610599852671'
													}
												],
												//  [
												// 	"pending",
												// 	"processing",
												// 	"partially_shipped",
												// 	"shipped",
												// 	"completed",
												// 	"canceled",
												// 	"payment_requested",
												// 	"preparing_to_ship",
												// 	"delivered",
												// 	"confirmed",
												// 	"delayed",
												// 	"out_for_delivery",
												// 	"failed"
												// ]
												status: WAPaymentOrderStatusEnum.PAYMENT_REQUESTED,
												subtotal: {
													offset: 1000,
													/// Esse valor abaixo representa 300
													/// 300 reais quantity * amount.value
													value: 300000
												},
												discount: {
													offset: 1000,
													/// Esse valor abaixo representa 20
													value: 20000
												},
												shipping: {
													offset: 1000,
													/// Esse valor abaixo representa 7
													value: 7000
												},
												tax: {
													offset: 1000,
													/// Esse valor abaixo representa 50
													value: 50000
												}
											},
											currency: 'BRL',
											// [
											// 	"digital-goods",
											// 	"physical-goods",
											// 	"any",
											// 	"none"
											// ];
											type: WAProductOrderTypeEnum.PHYSICAL_GOODS,
											payment_configuration: 'merchant_categorization_code',
											// Ver como gerar isso
											reference_id: '4SEQSGX7A9D',
											// Ver como gerar isso
											order_request_id: '4SEQSGX77XF',
											total_amount: {
												offset: 1000,
												// A soma de ((value * quantity) - discount + tax + shipping)
												value: 337000
											},
											native_payment_methods: ['cards'],
											payment_settings: [
												// Se for cartão deve ter esse campo
												{
													type: 'cards',
													cards: {
														enabled: true
													}
												},
												{
													type: 'pix_static_code', // pix_dynamic_code
													pix_static_code: {
														merchant_name: 'Nome da chave',
														key: '11111111111' // Chave PIX
													}
												}
											]
										})
									}
								]
							}
						}
					},
					{
						additionalNodes: [
							{
								tag: 'biz',
								attrs: {
									native_flow_name: WAInteractiveMessagesNativeFlowName.ORDER_DETAILS
								}
							}
						]
					}
				)
			}

			// Ainda em desenvolvimento
			// Botoes de atualizacao de STATUS do pedido
			async function sendButtonCode2() {
				await sock.relayMessage(
					'553195702237',
					{
						interactiveMessage: {
							nativeFlowMessage: {
								buttons: [
									{
										name: WANativeFlowButtonEnum.REVIEW_ORDER,
										// Seguir o exemplo do sendButtonCode1 para entender cada campo
										buttonParamsJson: JSON.stringify({
											order: {
												items: [
													{
														amount: {
															value: 150000,
															offset: 1000
														},
														isCustomItem: true,
														isQuantitySet: true,
														name: 'order 1',
														quantity: 2,
														retailer_id: 'custom-item-4N8FCTW23N7'
													},
													{
														amount: {
															value: 150000,
															offset: 1000
														},
														isCustomItem: false,
														isQuantitySet: true,
														name: 'order 2',
														quantity: 2,
														retailer_id: '23940797548900636'
													}
												],
												status: WAPaymentOrderStatusEnum.SHIPPED,
												subtotal: {
													offset: 1000,
													value: 600000
												},
												discount: {
													offset: 1000,
													value: 10000
												},
												shipping: {
													offset: 1000,
													value: 5000
												},
												tax: {
													offset: 1000,
													value: 10000
												}
											},
											currency: 'BRL',
											payment_status: WAPaymentStatusEnum.PENDING,
											payment_timestamp: 1750990799,
											reference_id: '4QDORZW7K27',
											total_amount: {
												offset: 1000,
												value: 605000
											}
										})
									}
								]
							}
						}
					},
					{
						additionalNodes: [
							{
								tag: 'biz',
								attrs: {
									native_flow_name: WAInteractiveMessagesNativeFlowName.ORDER_STATUS
								}
							}
						]
					}
				)
			}

			// Ainda em desenvolvimento
			// Botoes de atualizacao de STATUS do pagamento
			async function sendButtonCode3() {
				await sock.relayMessage(
					'553195702237',
					{
						interactiveMessage: {
							nativeFlowMessage: {
								buttons: [
									{
										name: WANativeFlowButtonEnum.PAYMENT_STATUS,
										// Seguir o exemplo do sendButtonCode1 para entender cada campo
										buttonParamsJson: JSON.stringify({
											order: {
												items: [
													{
														amount: { value: 150000, offset: 1000 },
														isCustomItem: true,
														isQuantitySet: true,
														name: 'order 1',
														quantity: 2,
														retailer_id: 'custom-item-4N8FCTW23N7'
													},
													{
														amount: { value: 150000, offset: 1000 },
														isCustomItem: false,
														isQuantitySet: true,
														name: 'order 2',
														quantity: 2,
														retailer_id: '23940797548900636'
													}
												],
												status: WAPaymentOrderStatusEnum.PROCESSING,
												subtotal: { offset: 1000, value: 600000 },
												discount: { offset: 1000, value: 10000 },
												shipping: { offset: 1000, value: 5000 },
												tax: { offset: 1000, value: 10000 }
											},
											currency: 'BRL',
											payment_status: WAPaymentStatusEnum.CAPTURED,
											payment_timestamp: 1750990830,
											reference_id: '4N8FCTW1WM6',
											total_amount: { offset: 1000, value: 605000 }
										})
									}
								]
							}
						}
					},
					{
						additionalNodes: [
							{
								tag: 'biz',
								attrs: {
									native_flow_name: WAInteractiveMessagesNativeFlowName.PAYMENT_STATUS
								}
							}
						]
					}
				)
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
						// Para pegar o botão que o usuário clicou
						const clickedButton = msg.message?.buttonsResponseMessage?.selectedButtonId || msg.message?.templateButtonReplyMessage?.selectedId

						// console.log(JSONmsg.message?.templateButtonReplyMessage)
// 
						if (clickedButton === 'abc') {
						}

						if (msg.key.fromMe) {
							console.log('is own message')
							if (msg.message?.conversation?.startsWith('!')) {
								const command = msg.message.conversation.slice(1).trim().toLowerCase()
								//

								if (command === 'otp') {
									await sendOtp()
								} else if (command === 'list') {
									await sendList()
								} else if (command === 'pix') {
									await sendPix()
								} else if (command === 'buttons') {
									await sendWithBasicButtons()
								} else if (command === 'multiple_buttons') {
									await sendWithMultipleButtons()
								} else if (command === 'multiple_buttons_with_image') {
									await sendWithMultipleButtonsWithImage()
								} else if (command === 'carousel') {
									await sendCarousel()
								} else {
									console.log('unknown command', command)
								}
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

			if (events['messaging-history.set']) {
				console.log('messaging-history.set', events['messaging-history.set'])
			}
		}
	)

	return sock
}

startSock()
