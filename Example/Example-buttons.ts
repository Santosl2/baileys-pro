import { Boom } from '@hapi/boom'
import NodeCache from '@cacheable/node-cache'
import readline from 'readline'
import makeWASocket, {
	BinaryInfo,
	DisconnectReason,
	encodeWAM,
	fetchLatestBaileysVersion,
	getAggregateVotesInPollMessage,
	makeCacheableSignalKeyStore,
	proto,
	useMultiFileAuthState,
	WAWebInteractiveMessagesNativeFlowNameEnum,
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
import { Mutex } from 'async-mutex'
import { PaymentOrderFunctions } from '../src/Utils/payment-order'

const logger = P({ timestamp: () => `,"time":"${new Date().toJSON()}"` }, P.destination('./wa-logs.txt'))
logger.level = 'trace'

const usePairingCode = process.argv.includes('--use-pairing-code')

// external map to store retry counts of messages when decryption/encryption fails
// keep this out of the socket itself, so as to prevent a message decryption/encryption loop across socket restarts
const msgRetryCounterCache = new NodeCache()

// Read line interface
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const question = (text: string) => new Promise<string>(resolve => rl.question(text, resolve))

const mutex = new Mutex()
const WHATSAPP_NUMBER = '553185702237@s.whatsapp.net'
// start a connection
const startSock = async () => {
	const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info')
	// fetch latest version of WA Web
	const { version, isLatest } = await fetchLatestWaWebVersion()
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
		// Essa linha abaixo envia listas como viewOnce message
		// patchMessageBeforeSending: msg => {
		// 	const requiresPatch = !!(msg.buttonsMessage || msg.templateMessage || msg.listMessage)
		// 	if (requiresPatch) {
		// 		msg = {

		// 				message: {
		// 					messageContextInfo: {
		// 						deviceListMetadata: {},
		// 						deviceListMetadataVersion: 2
		// 					},
		// 					...msg
		// 				}

		// 		}
		// 	}
		// 	return msg
		// }
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

			// sock.ws.on('CB:message', data => {
			// 	// Usado para debugar novas features
			// 	const filePath = './cb-messages.json'
			// 	mutex.runExclusive(() => {
			// 		fs.appendFileSync(filePath, JSON.stringify(data, null, 2) + '\n')
			// 	})
			// 	console.log('CB:message saved to', filePath)
			// })

			async function sendOtp() {
				await sock.sendMessage(WHATSAPP_NUMBER, {
					text: 'Seu código de verificação é: 123',
					interactiveButtons: [
						{
							name: WAWebInteractiveMessagesNativeFlowNameEnum.CTA_COPY,
							buttonParamsJson: '{"fix":true,"display_text":"Copiar código","copy_code":"123"}'
						}
					]
				})
			}

			// Funcionando
			async function sendList() {
				await sock.sendMessage(WHATSAPP_NUMBER, {
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

			// Funcionando
			async function sendPix() {
				await sock.sendMessage(WHATSAPP_NUMBER, {
					text: 'f',
					footer: 'se quiser vincular um rodapé',
					title: 'se quiser vincular um título',
					interactiveButtons: [
						{
							name: WAWebInteractiveMessagesNativeFlowNameEnum.PAYMENT_INFO,
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
					]
				})

				// await sock.relayMessage(
				// 	WHATSAPP_NUMBER,
				// 	{
				// 		interactiveMessage: {
				// 			nativeFlowMessage: {
				// 				buttons: [
				// 					{
				// 						name: WANativeFlowButtonEnum.PAYMENT_INFO,
				// 						buttonParamsJson: JSON.stringify({
				// 							currency: 'BRL',
				// 							total_amount: {
				// 								value: 12,
				// 								offset: 100
				// 							},
				// 							reference_id: '4SE1828Q8SA',
				// 							type: 'physical-goods',
				// 							order: {
				// 								status: 'pending',
				// 								subtotal: {
				// 									value: 0,
				// 									offset: 100
				// 								},
				// 								order_type: 'ORDER',
				// 								items: [
				// 									{
				// 										name: '',
				// 										amount: {
				// 											value: 0,
				// 											offset: 100
				// 										},
				// 										quantity: 0,
				// 										sale_amount: {
				// 											value: 0,
				// 											offset: 100
				// 										}
				// 									}
				// 								]
				// 							},
				// 							payment_settings: [
				// 								{
				// 									type: 'pix_static_code', // pix_DYNAMIC_code
				// 									pix_static_code: {
				// 										merchant_name: 'Matheus Filype',
				// 										key: 'mfilype2019@gmail.com', // Chave PIX,
				// 										key_type: WAPixTypes.EMAIL
				// 									}
				// 								}
				// 							]
				// 						})
				// 					}
				// 				],
				// 				messageVersion: 1
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
				// 							type: 'native_flow',
				// 							v: '1'
				// 						},
				// 						content: [
				// 							{
				// 								tag: 'native_flow',
				// 								attrs: {
				// 									name: 'payment_info'
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
			async function sendWithMultipleButtons() {
				await sock.sendMessage(WHATSAPP_NUMBER, {
					text: 'f',
					footer: 'se quiser vincular um rodapé',
					title: 'se quiser vincular um título',
					interactiveButtons: [
						{
							name: WAWebInteractiveMessagesNativeFlowNameEnum.CTA_CALL,
							buttonParamsJson: '{"fix":true,"display_text":"Fale conosco","phone_number":"+5531985702237"}'
						},
						{
							name: WAWebInteractiveMessagesNativeFlowNameEnum.CTA_URL,
							buttonParamsJson:
								'{"fix":true,"display_text":"Visite nosso site","url":"https://mfilype.dev","merchant_url":"https://mfilype.dev"}'
						}
					]
				})
			}

			// Funcionando
			async function sendWithMultipleButtonsWithImage() {
				await sock.sendMessage(WHATSAPP_NUMBER, {
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
							name: WAWebInteractiveMessagesNativeFlowNameEnum.CTA_CALL,
							buttonParamsJson: JSON.stringify({
								fix: true,
								display_text: 'Fale conosco',
								phone_number: '+5531985702237'
							})
						},
						{
							name: WAWebInteractiveMessagesNativeFlowNameEnum.CTA_URL,
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
				await sock.sendMessage(WHATSAPP_NUMBER, {
					text: 'Teste do Matheus',
					footer: 'se quiser vincular um rodapé',

					interactiveButtons: [
						{
							name: WAWebInteractiveMessagesNativeFlowNameEnum.REPLY,
							buttonParamsJson: JSON.stringify({
								fix: true,
								display_text: 'Fale conosco',
								id: 'abc'
							})
						},
						{
							name: WAWebInteractiveMessagesNativeFlowNameEnum.REPLY,
							buttonParamsJson: JSON.stringify({
								fix: true,
								display_text: 'Fale conoscoc',
								id: 'abcd'
							})
						}
					]
				})
			}

			async function sendButtonsWithNewFormat() {
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

				await sock.sendMessage(WHATSAPP_NUMBER, buttonMessage)
			}

			// Em desenvolvimento
			// Todo: Ainda em desenvolvimento
			async function sendCarousel() {
				await sock.relayMessage(
					WHATSAPP_NUMBER,
					{
						interactiveMessage: {
							body: {
								text: 'interactiveMessage body text'
							},
							header: {
								subtitle: 'interactiveMessage header subtitle',
								title: 'interactiveMessage header title'
							},
							footer: {
								text: 'interactiveMessage footer text'
							},
							carouselMessage: {
								cards: [
									{
										body: {
											text: 'Confira os detalhes deste imóvel incrível!'
										},
										header: {
											imageMessage: {
												url: 'https://mmg.whatsapp.net/v/t62.7118-24/594455939_1162743569378730_870142133335658881_n.enc?ccb=11-4&oh=01_Q5Aa3AHwoVxUtNUK3tzxUnBIGfpoCcGqJsHVbyL0l_B214tW5w&oe=69592EF8&_nc_sid=5e03e0&mms3=true',
												mimetype: 'image/jpeg',
												fileSha256: 'feQcLN6bS6o7OQSlr4aHlf+8x79Rf1VltDPJ0lDZ7DM=',
												fileLength: '235495',
												height: 1200,
												width: 1600,
												mediaKey: 'yNIs+8C36tKRBaEevvWtKcc4SSNQWS6LVS74c8OPzho=',
												fileEncSha256: 'NAkGPgG75UtWqGMh0PiGEsBNN28YCh/tE2xvTOSx+Xs=',
												directPath:
													'/v/t62.7118-24/594455939_1162743569378730_870142133335658881_n.enc?ccb=11-4&oh=01_Q5Aa3AHwoVxUtNUK3tzxUnBIGfpoCcGqJsHVbyL0l_B214tW5w&oe=69592EF8&_nc_sid=5e03e0',
												mediaKeyTimestamp: '1764874342',
												jpegThumbnail:
													'/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAFA3PEY8MlBGQUZaVVBfeMiCeG5uePWvuZHI////////////////////////////////////////////////////2wBDAVVaWnhpeOuCguv/////////////////////////////////////////////////////////////////////////wAARCAA2AEgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwBlLQOlIM7jnp2oAdmjNSlUKjgZIqEjDYpAPAzS4oVcmlcbT1pgMAopXHA9xSxL82fQZpAMNFObrRTAZS03NM3kt1x7UAWAflX2NI33jUW4gHnFOWTzCcCkBOnQE02RgzcGoGJBPvTlTdggY96AJHOcY7CkikHzDvjFMkG1TzUMZJcDNMCyaKKKAIiME1Gy/NkVORnmjbxQBAEZicnoaniTa2B0xQI8kn1qUDHFABtFL3xRSUgGyqGBFQxxbHzmpzSGgAooopgMXripBRRSAOlLRRQAUUUUAJ3pD0oooASiiimB/9k='
											},
											hasMediaAttachment: true
										},
										nativeFlowMessage: {
											buttons: [
												{
													name: 'cta_url',
													buttonParamsJson:
														'{"display_text":"Ver Detalhes","url":"https:\\/\\/w.meta.me\\/s\\/1QzVhonRRY37yUR","webview_presentation":null,"payment_link_preview":false,"landing_page_url":"https:\\/\\/app.useplaza.com.br\\/public_listings\\/Z2lkOi8vcGxhemEvTGlzdGluZy84MTkxMDI","webview_interaction":false}'
												},
												{
													name: 'quick_reply',
													buttonParamsJson:
														'{"display_text":"\\ud83d\\udc49 Quero visitar o Im\\u00f3vel 1","id":"\\ud83d\\udc49 Quero visitar o Im\\u00f3vel 1"}'
												}
											]
										}
									},
									{
										header: {
											imageMessage: {
												url: 'https://mmg.whatsapp.net/v/t62.7118-24/548105480_1942483740011072_8801691802776095965_n.enc?ccb=11-4&oh=01_Q5Aa3AEZbubAspW8E1BqMeP8Xu3dfVImOyCC4GOOzEXBbuWcBA&oe=69594090&_nc_sid=5e03e0&mms3=true',
												mimetype: 'image/jpeg',
												fileSha256: 'mcncefYx/cmrW/9JpQ88cUfGEEeR8X0PDm5tt+MWdZA=',
												fileLength: '107620',
												height: 1600,
												width: 720,
												mediaKey: 'XgCsjwKUkajygl69rWJ4sO47IENlJ7q9KoH0/ws9Zss=',
												fileEncSha256: 'OxRvq2jmme0GUio4XMHNcbk7MgBVXMyVsLtDjmXOfzE=',
												directPath:
													'/v/t62.7118-24/548105480_1942483740011072_8801691802776095965_n.enc?ccb=11-4&oh=01_Q5Aa3AEZbubAspW8E1BqMeP8Xu3dfVImOyCC4GOOzEXBbuWcBA&oe=69594090&_nc_sid=5e03e0',
												mediaKeyTimestamp: '1764874342',
												jpegThumbnail:
													'/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAFA3PEY8MlBGQUZaVVBfeMiCeG5uePWvuZHI////////////////////////////////////////////////////2wBDAVVaWnhpeOuCguv/////////////////////////////////////////////////////////////////////////wAARCABIACADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwApaUYPSl20ANoNOKEUh4oATaBnIP1FN81kfHUU3PyZLEfMe9N6sD14oAsNK2wHaOfeo8ljjbj8acfuqPr/ADoQcMfagBuFOcDPOeaVQM5JGRTEjI6nj0ptxgBccUhj5JPmAUjp3FMMvzFSeO+KiU56n6UuBuwP51Qi1Ubru96cDSr1qQK7IAelMIwatSAZ4qJl5pgSDgUA0UUgA800daKKYH//2Q=='
											},
											hasMediaAttachment: true
										},
										nativeFlowMessage: {
											buttons: [
												{
													name: 'cta_url',
													buttonParamsJson:
														'{"display_text":"Ver Detalhes","url":"https:\\/\\/w.meta.me\\/s\\/21SLSmXkLlF6kWu","webview_presentation":null,"payment_link_preview":false,"landing_page_url":"https:\\/\\/app.useplaza.com.br\\/public_listings\\/Z2lkOi8vcGxhemEvTGlzdGluZy85MTM3NTc","webview_interaction":false}'
												},
												{
													name: 'quick_reply',
													buttonParamsJson:
														'{"display_text":"\\ud83d\\udc49 Quero visitar o Im\\u00f3vel 2","id":"\\ud83d\\udc49 Quero visitar o Im\\u00f3vel 2"}'
												}
											]
										}
									},
									{
										header: {
											imageMessage: {
												url: 'https://mmg.whatsapp.net/v/t62.7118-24/594455961_2558621821191776_6559099629674964160_n.enc?ccb=11-4&oh=01_Q5Aa3AFdf8E44o1tNQWFWUWtVYnIAeqxCJ8EEb9U9snLKdMgvg&oe=69595C24&_nc_sid=5e03e0&mms3=true',
												mimetype: 'image/jpeg',
												fileSha256: 'JT6hasQhf/yTXKbu690HOOhZzvMVyRZQbQ/Va1FGyLM=',
												fileLength: '49032',
												height: 960,
												width: 1280,
												mediaKey: 'S1wTSXWpbuw9Xr64HMfLRc0sJAmQdpTYKVqInfqxTR4=',
												fileEncSha256: 'VJslVZ/Wvbf2dGKMUWfPmCZC5Sd13zyfvaODct8nj6o=',
												directPath:
													'/v/t62.7118-24/594455961_2558621821191776_6559099629674964160_n.enc?ccb=11-4&oh=01_Q5Aa3AFdf8E44o1tNQWFWUWtVYnIAeqxCJ8EEb9U9snLKdMgvg&oe=69595C24&_nc_sid=5e03e0',
												mediaKeyTimestamp: '1764874342',
												jpegThumbnail:
													'/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAFA3PEY8MlBGQUZaVVBfeMiCeG5uePWvuZHI////////////////////////////////////////////////////2wBDAVVaWnhpeOuCguv/////////////////////////////////////////////////////////////////////////wAARCAA2AEgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCQjFJTsZo20ANop22jFADaKa7bDimeZ7UASEim59BTWJFJk+ppXHYcQaKhfpRQBdHWnCmU4UxCmmjrSkgU0EUAQ3H31pAg6nNOm5K45xTDnNIY5+gplK9JUjGPRQ9FUhMuU0sc4zTqjfrTELmkpM0ZoAU03bTqKAGlc00qRUlLRYLlc/fHtRTpuox34opoCUuTTaKKQCUUUUALmjNFFACg06iigCOb7o+tFFFMD//Z'
											},
											hasMediaAttachment: true
										},
										nativeFlowMessage: {
											buttons: [
												{
													name: 'cta_url',
													buttonParamsJson:
														'{"display_text":"Ver Detalhes","url":"https:\\/\\/w.meta.me\\/s\\/1ZVGuG67yrWEqZJ","webview_presentation":null,"payment_link_preview":false,"landing_page_url":"https:\\/\\/app.useplaza.com.br\\/public_listings\\/Z2lkOi8vcGxhemEvTGlzdGluZy84NzIxNzM","webview_interaction":false}'
												},
												{
													name: 'quick_reply',
													buttonParamsJson:
														'{"display_text":"\\ud83d\\udc49 Quero visitar o Im\\u00f3vel 3","id":"\\ud83d\\udc49 Quero visitar o Im\\u00f3vel 3"}'
												}
											]
										}
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
													v: '2',
													name: 'mixed'
												}
											}
										]
									}
								]
							}
						]
					}
				)
				await sock.sendMessage(WHATSAPP_NUMBER, {
					text: 'Teste do matheus',
					subtitle: 'se quiser vincular um subtítulo',
					title: 'se quiser vincular um título',
					footer: 'se quiser vincular um rodapé',
					cards: [
						{
							body: 'fff',
							image: {
								url: 'https://cdn.pixabay.com/photo/2024/05/14/11/37/tv-8760950_1280.png'
							},
							buttons: [
								{
									name: 'cta_url',
									buttonParamsJson:
										'{"display_text":"Ver Detalhes","url":"https:\\/\\/w.meta.me\\/s\\/1QzVhonRRY37yUR","webview_presentation":null,"payment_link_preview":false,"landing_page_url":"https:\\/\\/app.useplaza.com.br\\/public_listings\\/Z2lkOi8vcGxhemEvTGlzdGluZy84MTkxMDI","webview_interaction":false}'
								},
								{
									name: 'quick_reply',
									buttonParamsJson:
										'{"display_text":"\\ud83d\\udc49 Quero visitar o Im\\u00f3vel 1","id":"\\ud83d\\udc49 Quero visitar o Im\\u00f3vel 1"}'
								}
							]
						},
						{
							body: 'fff',
							image: {
								url: 'https://cdn.pixabay.com/photo/2024/05/14/11/37/tv-8760950_1280.png'
							},
							buttons: [
								{
									name: 'cta_url',
									buttonParamsJson:
										'{"display_text":"Ver Detalhes","url":"https:\\/\\/w.meta.me\\/s\\/1QzVhonRRY37yUR","webview_presentation":null,"payment_link_preview":false,"landing_page_url":"https:\\/\\/app.useplaza.com.br\\/public_listings\\/Z2lkOi8vcGxhemEvTGlzdGluZy84MTkxMDI","webview_interaction":false}'
								},
								{
									name: 'quick_reply',
									buttonParamsJson:
										'{"display_text":"\\ud83d\\udc49 Quero visitar o Im\\u00f3vel 1","id":"\\ud83d\\udc49 Quero visitar o Im\\u00f3vel 1"}'
								}
							]
						}
					]
				})
			}

			async function sendBoleto() {
				await sock.sendMessage(WHATSAPP_NUMBER, {
					text: 'f',
					footer: 'se quiser vincular um rodapé',
					title: 'se quiser vincular um título',
					interactiveButtons: [
						{
							name: WAWebInteractiveMessagesNativeFlowNameEnum.REVIEW_AND_PAY,
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

									status: WAPaymentOrderStatusEnum.PENDING,
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

								type: WAProductOrderTypeEnum.DIGITAL_GOODS,
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
								// native_payment_methods: ['cards'],
								payment_type: 'br',
								payment_settings: [
									{
										type: 'pix_static_code', // pix_DYNAMIC_code
										pix_static_code: {
											merchant_name: 'Matheus Filype',
											key: 'mfilype2019@gmail.com', // Chave PIX,
											key_type: WAPixTypes.EMAIL
										}
									},
									{
										type: 'boleto',
										boleto: {
											digitable_line: '03399026944140000002628346101018898510000008848'
										}
									}
								]
							})
						}
					]
				})

				await sock.relayMessage(
					WHATSAPP_NUMBER,
					{
						interactiveMessage: {
							header: {
								documentMessage: {}
							},
							body: {
								text: 'Your message content'
							},

							nativeFlowMessage: {
								buttons: [
									{
										name: WAWebInteractiveMessagesNativeFlowNameEnum.REVIEW_AND_PAY,
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

												status: WAPaymentOrderStatusEnum.PENDING,
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

											type: WAProductOrderTypeEnum.DIGITAL_GOODS,
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
											// native_payment_methods: ['cards'],
											payment_type: 'br',
											payment_settings: [
												{
													type: 'pix_static_code', // pix_DYNAMIC_code
													pix_static_code: {
														merchant_name: 'Matheus Filype',
														key: 'mfilype2019@gmail.com', // Chave PIX,
														key_type: WAPixTypes.EMAIL
													}
												},
												{
													type: 'boleto',
													boleto: {
														digitable_line: '03399026944140000002628346101018898510000008848'
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

			const items: Array<{
				name: string
				quantity: number
				retailer_id: string
				amount: {
					offset: number
					value: number
				}
			}> = [
				{
					name: 'pagamento api',
					quantity: 1,
					retailer_id: PaymentOrderFunctions.generateCustomRetailerId(),
					amount: {
						offset: 1,
						value: 4000
					}
				},
				{
					name: 'serviço api',
					quantity: 1,
					retailer_id: PaymentOrderFunctions.generateCustomRetailerId(),
					amount: {
						offset: 1,
						value: 1000
					}
				}
			]

			const totalAmount = items.reduce((acc, item) => acc + item.amount.value * item.quantity, 0)

			type PaymentSettings =
				| {
						type: 'boleto'
						boleto: {
							digitable_line: string
						}
				  }
				| {
						type: 'pix_static_code'
						pix_static_code: {
							merchant_name: string
							key: string
							key_type: WAPixTypes
						}
				  }
				| {
						type: 'cards'
						cards: {
							enabled: true
						}
				  }

			const paymentSettings: PaymentSettings[] = [
				{ type: 'cards', cards: { enabled: true } },
				{
					type: 'boleto',
					boleto: {
						digitable_line: '03399026944140000002628346101018898510000008848'
					}
				},
				{
					type: 'pix_static_code',
					pix_static_code: {
						key: 'mfilype2019@gmail.com',
						key_type: WAPixTypes.EMAIL,
						merchant_name: 'Matheus Filype'
					}
				}
			]

			async function sendCustomPaymentOrder(title: string) {
				const refID = PaymentOrderFunctions.generateReferenceId()
				const data = await sock.sendMessage('553185702237@s.whatsapp.net', {
					text: '',
					paymentOrder: {
						referenceId: refID,
						paymentSettings: [
							{
								type: 'pix_static_code',
								pix_static_code: {
									key: 'mfilype2019@gmail.com',
									key_type: WAPixTypes.EMAIL,
									merchant_name: 'Matheus Filype'
								}
							},
							{
								type: 'boleto',
								boleto: {
									digitable_line: '03399026944140000002628346101018898510000008848'
								}
							}
						],
						items: [
							{
								retailer_id: PaymentOrderFunctions.generateCustomRetailerId(),
								amount: {
									offset: 1,
									value: 2500
								},
								name: title,
								quantity: 2
							}
						]
					}
				})

				await sendOrderStatusChange(refID, WAPaymentOrderStatusEnum.CONFIRMED, data)
			}

			async function sendNewPixPaymentFormat() {
				await sock.sendMessage('553185702237@s.whatsapp.net', {
					text: '',
					paymentOrder: {
						referenceId: PaymentOrderFunctions.generateReferenceId(),
						referral: 'chat_attachment',
						amount: 100,
						paymentSettings: [
							{
								type: 'pix_static_code',
								pix_static_code: {
									key: 'mfilype2019@gmail.com',
									key_type: WAPixTypes.EMAIL,
									merchant_name: 'Matheus Filype'
								}
							},
							{
								type: 'cards',
								cards: {
									enabled: false
								}
							}
						]
					}
				})
			}

			async function sendCustomPaymentOrderComplete(title: string, amount: number) {
				if (amount > 5000) {
					throw new Error('Amount too high. Max is 5000')
				}

				if (amount < 1) {
					throw new Error('Amount too low. Min is 1')
				}

				const referenceId = generateReferenceId()

				await sock.relayMessage(
					'553185702237@s.whatsapp.net',
					{
						interactiveMessage: {
							nativeFlowMessage: {
								buttons: [
									{
										name: WAWebInteractiveMessagesNativeFlowNameEnum.REVIEW_AND_PAY,
										// Seguir o exemplo do sendButtonCode1 para entender cada campo
										buttonParamsJson: JSON.stringify({
											type: 'physical-goods',
											additional_note: '',
											payment_settings: paymentSettings,
											total_amount: {
												offset: 1,
												value: totalAmount
											},
											order: {
												subtotal: {
													value: totalAmount,
													offset: 1
												},
												items,
												order_type: 'ORDER',
												status: 'payment_requested'
											},
											reference_id: referenceId,
											currency: 'BRL'
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
								attrs: {},
								content: [
									{
										tag: 'interactive',
										attrs: {
											v: '1',
											type: 'native_flow'
										},
										content: [
											{
												tag: 'native_flow',
												attrs: {
													name: 'order_details'
												}
											}
										]
									}
								]
							}
						]
					}
				)

				// await sendOrderStatusChange(referenceId)
				// TODO: Para que ele consiga enviar as outras etapas, é necessário que a mensagem do pedido esteja como `quoted`
				// await delay(2000)
				// await sendOrderStatusChange(referenceId, WAPaymentOrderStatusEnum.PROCESSING)
				// await delay(2000)
				// await sendOrderStatusChange(referenceId, WAPaymentOrderStatusEnum.OUT_FOR_DELIVERY)
				// await delay(2000)
				// await sendOrderStatusChange(referenceId, WAPaymentOrderStatusEnum.COMPLETE)
				// await delay(2000)
				// await sendOrderPaymentChange(referenceId, 'captured')
			}

			// Enviado quando o status do pedido muda
			async function sendOrderStatusChange(
				referenceId: string,
				status: WAPaymentOrderStatusEnum = WAPaymentOrderStatusEnum.CONFIRMED,
				msg: any
			) {
				await sock.sendMessage(
					'553185702237@s.whatsapp.net',
					{
						text: '',
						orderChangeStatus: {
							referenceId,
							status
						}
					},
					{
						quoted: msg
					}
				)
				// await sock.relayMessage(
				// 	'553185702237@s.whatsapp.net',
				// 	{
				// 		// messageContextInfo: contextInfo,
				// 		interactiveMessage: {
				// 			nativeFlowMessage: {
				// 				buttons: [
				// 					{
				// 						name: WAWebInteractiveMessagesNativeFlowNameEnum.REVIEW_ORDER,
				// 						buttonParamsJson: JSON.stringify({
				// 							order: {
				// 								status
				// 							},
				// 							reference_id: referenceId
				// 						})
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
				// 							v: '1',
				// 							type: 'native_flow'
				// 						},
				// 						content: [
				// 							{
				// 								tag: 'native_flow',
				// 								attrs: {
				// 									name: 'order_status'
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

			async function sendOrderPaymentChange(referenceId: string, status: 'pending' | 'captured' = 'captured') {
				await sock.relayMessage(
					'553185702237@s.whatsapp.net',
					{
						interactiveMessage: {
							nativeFlowMessage: {
								buttons: [
									{
										name: WAWebInteractiveMessagesNativeFlowNameEnum.PAYMENT_STATUS,
										buttonParamsJson: JSON.stringify({
											reference_id: referenceId,
											payment_status: status,
											payment_timestamp: new Date().getTime()
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
								attrs: {},
								content: [
									{
										tag: 'interactive',
										attrs: {
											v: '1',
											type: 'native_flow'
										},
										content: [
											{
												tag: 'native_flow',
												attrs: {
													name: 'payment_status'
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
										name: WAWebInteractiveMessagesNativeFlowNameEnum.REVIEW_AND_PAY,
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
										name: WAWebInteractiveMessagesNativeFlowNameEnum.REVIEW_ORDER,
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
										name: WAWebInteractiveMessagesNativeFlowNameEnum.PAYMENT_STATUS,
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
				const filePath = './messages.json'
				mutex.runExclusive(() => {
					fs.appendFileSync(filePath, JSON.stringify(upsert, null, 2) + '\n')
				})
				//console.log('got messages ', JSON.stringify(upsert.messages, undefined, 2))
				if (upsert.type === 'notify') {
					for (const msg of upsert.messages) {
						if (msg.key.fromMe) {
							console.log('is own message')
							if (
								msg.message?.conversation?.startsWith('!') ||
								msg.message?.extendedTextMessage?.text?.startsWith('!')
							) {
								const command =
									msg.message.conversation?.slice(1).trim().toLowerCase() ||
									msg.message?.extendedTextMessage?.text?.slice(1).trim().toLowerCase()
								// msg.message.buttonsResponseMessage?.selectedButtonId

								if (command === 'pix_new') {
									await sendNewPixPaymentFormat()
								} else if (command === 'pay') {
									await sendCustomPaymentOrder('teste')
								} else if (command === 'otp') {
									await sendOtp()
								} else if (command === 'list') {
									await sendList()
								} else if (command === 'boleto') {
									await sendBoleto()
								} else if (command === 'pix') {
									await sendPix()
								} else if (command === 'buttons') {
									// await sendWithBasicButtons() / Não notifica no web wpp
									await sendButtonsWithNewFormat()
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
		}
	)

	return sock
}

startSock()
