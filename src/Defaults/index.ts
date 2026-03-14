import NodeCache from '@cacheable/node-cache'
import { LRUCache } from 'lru-cache'
import { proto } from '../../WAProto'
import { makeLibSignalRepository } from '../Signal/libsignal'
import type { AuthenticationState, CacheStore, MediaType, SocketConfig, WAVersion } from '../Types'
import { Browsers } from '../Utils'
import logger from '../Utils/logger'
import { version } from './baileys-version.json'

export const DEFAULT_CACHE_TTLS = {
	SIGNAL_STORE: 5 * 60, // 5 minutes
	MSG_RETRY: 60 * 60, // 1 hour
	CALL_OFFER: 5 * 60, // 5 minutes
	USER_DEVICES: 5 * 60, // 5 minutes
	GROUP_METADATA: 15 * 60 // 15 minutes
}

export const DEFAULT_CACHE_MAX_KEYS = {
	MSG_RETRY: 1000,
	CALL_OFFER: 200,
	IDENTITY_ASSERT: 500,
	PLACEHOLDER_RESEND: 500
}

export const UNAUTHORIZED_CODES = [401, 403, 419]

export const DEFAULT_ORIGIN = 'https://web.whatsapp.com'
export const DEF_CALLBACK_PREFIX = 'CB:'
export const DEF_TAG_PREFIX = 'TAG:'
export const PHONE_CONNECTION_CB = 'CB:Pong'

export const WA_DEFAULT_EPHEMERAL = 7 * 24 * 60 * 60

export const NOISE_MODE = 'Noise_XX_25519_AESGCM_SHA256\0\0\0\0'
export const DICT_VERSION = 3
export const KEY_BUNDLE_TYPE = Buffer.from([5])
export const NOISE_WA_HEADER = Buffer.from([87, 65, 6, DICT_VERSION]) // last is "DICT_VERSION"
/** from: https://stackoverflow.com/questions/3809401/what-is-a-good-regular-expression-to-match-a-url */
export const URL_REGEX = /https:\/\/(?![^:@\/\s]+:[^:@\/\s]+@)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(:\d+)?(\/[^\s]*)?/g

export const WA_CERT_DETAILS = {
	SERIAL: 0,
	ISSUER: 'WhatsAppLongTerm1',
	PUBLIC_KEY: Buffer.from('142375574d0a587166aae71ebe516437c4a28b73e3695c6ce1f7f9545da8ee6b', 'hex')
}

/** Status messages older than 24 hours are considered expired */
export const STATUS_EXPIRY_SECONDS = 24 * 60 * 60

/** WA Web enforces a 14-day maximum age for placeholder resend requests */
export const PLACEHOLDER_MAX_AGE_SECONDS = 14 * 24 * 60 * 60

export const PROCESSABLE_HISTORY_TYPES = [
	proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
	proto.HistorySync.HistorySyncType.PUSH_NAME,
	proto.HistorySync.HistorySyncType.RECENT,
	proto.HistorySync.HistorySyncType.FULL,
	proto.HistorySync.HistorySyncType.ON_DEMAND,
	proto.HistorySync.HistorySyncType.NON_BLOCKING_DATA,
	proto.HistorySync.HistorySyncType.INITIAL_STATUS_V3
]

export const KEEPALIVE_INTERVAL_MIN = 20_000
export const KEEPALIVE_INTERVAL_MAX = 30_000

const MAX_RECENT_MESSAGE_SENT_HISTORY = 256
const recentMessageSentHistory = new Map<string, proto.IMessage>()

const mediaCacheFactory = (): CacheStore => {
	const mediaCache = new LRUCache<string, Buffer>({
		max: 15
	})

	return {
		get: <T>(key: string) => mediaCache.get(key) as T | undefined,
		set: <T = Buffer>(key: string, value: T) => mediaCache.set(key, value as any),
		del: (key: string) => mediaCache.delete(key),
		flushAll: () => mediaCache.clear()
	}
}

export const DEFAULT_CONNECTION_CONFIG: SocketConfig = {
	version: version as WAVersion,
	browser: Browsers.macOS('Chrome'),
	waWebSocketUrl: 'wss://web.whatsapp.com/ws/chat',
	connectTimeoutMs: 20_000,
	keepAliveIntervalMs: 30_000,
	logger: logger.child({ class: 'baileys' }),
	emitOwnEvents: true,
	defaultQueryTimeoutMs: 60_000,
	customUploadHosts: [],
	retryRequestDelayMs: 250,
	maxMsgRetryCount: 5,
	fireInitQueries: true,
	auth: undefined as unknown as AuthenticationState,
	markOnlineOnConnect: true,
	syncFullHistory: false,
	patchMessageBeforeSending: msg => msg,
	shouldSyncHistoryMessage: ({ syncType }: proto.Message.IHistorySyncNotification) => {
		return syncType === proto.HistorySync.HistorySyncType.RECENT
	},
	shouldIgnoreJid: async () => Promise.resolve(false),
	linkPreviewImageThumbnailWidth: 192,
	transactionOpts: { maxCommitRetries: 10, delayBetweenTriesMs: 3000 },
	generateHighQualityLinkPreview: false,
	options: {},
	appStateMacVerification: {
		patch: false,
		snapshot: false
	},
	countryCode: 'US',
	getMessage: async () => undefined,
	// cachedGroupMetadata: async () => undefined,
	makeSignalRepository: makeLibSignalRepository,

	mediaCache: mediaCacheFactory(),
	linkPreviewCache: new NodeCache({
		useClones: false,
		stdTTL: DEFAULT_CACHE_TTLS.GROUP_METADATA
	}) as any,
	groupMetadataCache: new NodeCache({
		useClones: false,
		stdTTL: DEFAULT_CACHE_TTLS.GROUP_METADATA
	}) as any,

	enableAutoSessionRecreation: false,
	sendReportingTag: true,

	recentMessageSentHistory: {
		// TODO: use sqlite and async mutex
		get: (from, messageId) => recentMessageSentHistory.get(`${from}:${messageId}`),
		set: (from, messageId, message) => {
			const key = `${from}:${messageId}`
			if (recentMessageSentHistory.has(key)) {
				recentMessageSentHistory.delete(key)
			}

			if (recentMessageSentHistory.size >= MAX_RECENT_MESSAGE_SENT_HISTORY) {
				const firstKey = recentMessageSentHistory.keys().next().value
				if (firstKey) {
					recentMessageSentHistory.delete(firstKey)
				}
			}

			recentMessageSentHistory.set(key, message)
		}
	}
}

export const MEDIA_PATH_MAP: { [T in MediaType]?: string } = {
	image: '/mms/image',
	video: '/mms/video',
	document: '/mms/document',
	audio: '/mms/audio',
	sticker: '/mms/image',
	'thumbnail-link': '/mms/image',
	'product-catalog-image': '/product/image',
	'md-app-state': '',
	'md-msg-hist': '/mms/md-app-state'
}

export const MEDIA_HKDF_KEY_MAPPING = {
	audio: 'Audio',
	document: 'Document',
	gif: 'Video',
	image: 'Image',
	ppic: '',
	product: 'Image',
	ptt: 'Audio',
	sticker: 'Image',
	video: 'Video',
	'thumbnail-document': 'Document Thumbnail',
	'thumbnail-image': 'Image Thumbnail',
	'thumbnail-video': 'Video Thumbnail',
	'thumbnail-link': 'Link Thumbnail',
	'md-msg-hist': 'History',
	'md-app-state': 'App State',
	'product-catalog-image': '',
	'payment-bg-image': 'Payment Background',
	ptv: 'Video'
}

export const MEDIA_KEYS = Object.keys(MEDIA_PATH_MAP) as MediaType[]

export const MIN_PREKEY_COUNT = 5

export const INITIAL_PREKEY_COUNT = 30

export const TimeMs = {
	Minute: 60 * 1000,
	Hour: 60 * 60 * 1000,
	Day: 24 * 60 * 60 * 1000,
	Week: 7 * 24 * 60 * 60 * 1000
}