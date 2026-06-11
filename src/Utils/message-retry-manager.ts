import { LRUCache } from 'lru-cache'
import type { proto } from '../../WAProto/index.js'
import type { ILogger } from './logger'

/** Timeout for session recreation - 1 hour */
const RECREATE_SESSION_TIMEOUT = 60 * 60 * 1000 // 1 hour in milliseconds
export interface RecentMessageKey {
	to: string
	id: string
}

export interface RecentMessage {
	message: proto.IMessage
	timestamp: number
}

export interface SessionRecreateHistory {
	[jid: string]: number // timestamp
}

export interface RetryCounter {
	[messageId: string]: number
}

export type PendingPhoneRequest = Record<string, ReturnType<typeof setTimeout>>

export interface RetryStatistics {
	totalRetries: number
	successfulRetries: number
	failedRetries: number
	mediaRetries: number
	sessionRecreations: number
	phoneRequests: number
}

// Retry reason codes matching WhatsApp Web's Signal error codes.
export enum RetryReason {
	UnknownError = 0,
	SignalErrorNoSession = 1,
	SignalErrorInvalidKey = 2,
	SignalErrorInvalidKeyId = 3,
	/** MAC verification failed - most common cause of decryption failures */
	SignalErrorInvalidMessage = 4,
	SignalErrorInvalidSignature = 5,
	SignalErrorFutureMessage = 6,
	/** Explicit MAC failure - session is definitely out of sync */
	SignalErrorBadMac = 7,
	SignalErrorInvalidSession = 8,
	SignalErrorInvalidMsgKey = 9,
	BadBroadcastEphemeralSetting = 10,
	UnknownCompanionNoPrekey = 11,
	AdvFailure = 12,
	StatusRevokeDelay = 13
}

/** Error codes that indicate a MAC failure and require immediate session recreation */
const MAC_ERROR_CODES = new Set([RetryReason.SignalErrorInvalidMessage, RetryReason.SignalErrorBadMac])

export class MessageRetryManager {
	private sessionRecreateHistory = new LRUCache<string, number>({
		ttl: RECREATE_SESSION_TIMEOUT * 1,
		ttlAutopurge: true
	})
	private retryCounters = new LRUCache<string, number>({
		ttl: 15 * 60 * 1000,
		ttlAutopurge: true,
		updateAgeOnGet: true
	}) // 15 minutes TTL

	constructor(private logger: ILogger) {}

	/**
	 * Check if a session should be recreated based on retry count, history, and error code.
	 * MAC errors (codes 4 and 7) trigger immediate session recreation regardless of timeout.
	 */
	shouldRecreateSession(
		jid: string,
		hasSession: boolean,
		errorCode?: RetryReason
	): { reason: string; recreate: boolean } {
		// If we don't have a session, always recreate
		if (!hasSession) {
			this.sessionRecreateHistory.set(jid, Date.now())

			return {
				reason: "we don't have a Signal session with them",
				recreate: true
			}
		}

		// IMMEDIATE recreation for MAC errors - session is definitely out of sync
		if (errorCode !== undefined && MAC_ERROR_CODES.has(errorCode)) {
			this.logger.warn(
				{ jid, errorCode: RetryReason[errorCode] },
				'MAC error detected, forcing immediate session recreation'
			)
			return {
				reason: `MAC error (code ${errorCode}: ${RetryReason[errorCode]}), immediate session recreation`,
				recreate: true
			}
		}

		const now = Date.now()
		const prevTime = this.sessionRecreateHistory.get(jid)

		if (!prevTime || now - prevTime > RECREATE_SESSION_TIMEOUT) {
			this.sessionRecreateHistory.set(jid, now)

			return {
				reason: 'retry count > 1 and over an hour since last recreation',
				recreate: true
			}
		}

		return { reason: '', recreate: false }
	}

	clear(): void {
		this.sessionRecreateHistory.clear()
		this.retryCounters.clear()
	}
}
