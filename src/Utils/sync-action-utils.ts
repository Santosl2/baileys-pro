import { Boom } from '@hapi/boom'
import type { LTHashState, WAPatchName } from '../Types'
import { type BinaryNode } from '../WABinary'

export class SyncdMissingKeyError extends Boom {
	readonly keyId: string

	constructor(keyId: string, data?: object) {
		super(`failed to find key "${keyId}" to decode mutation`, {
			statusCode: 404,
			data: { keyId, ...data }
		})
		this.keyId = keyId
		Object.setPrototypeOf(this, SyncdMissingKeyError.prototype)
	}
}

const MISSING_KEY_MESSAGE_PATTERN = 'failed to find key'

function hasMissingKeyMessage(message: string | undefined): boolean {
	return message?.includes(MISSING_KEY_MESSAGE_PATTERN) ?? false
}

/** Type guard to check if an error is a missing sync key error */
export function isSyncdMissingKeyError(error: unknown): error is SyncdMissingKeyError | Boom | Error {
	if (error instanceof SyncdMissingKeyError) {
		return true
	}

	if (error instanceof Boom) {
		return error.output?.statusCode === 404 && hasMissingKeyMessage(error.message)
	}

	if (error instanceof Error) {
		return hasMissingKeyMessage(error.message)
	}

	return false
}

/** Manages collections blocked waiting for app-state-sync-keys */
export class BlockedCollectionsManager {
	private readonly blocked = new Set<WAPatchName>()

	block(collection: WAPatchName): void {
		this.blocked.add(collection)
	}

	isBlocked(collection: WAPatchName): boolean {
		return this.blocked.has(collection)
	}

	flush(): WAPatchName[] {
		if (this.blocked.size === 0) {
			return []
		}

		const collections = Array.from(this.blocked)
		this.blocked.clear()
		return collections
	}

	get size(): number {
		return this.blocked.size
	}

	get hasBlocked(): boolean {
		return this.blocked.size > 0
	}

	getBlocked(): readonly WAPatchName[] {
		return Array.from(this.blocked)
	}
}

export enum SyncErrorAction {
	BLOCK_ON_KEY = 'BLOCK_ON_KEY',
	RETRY = 'RETRY',
	ABORT = 'ABORT'
}

export interface SyncErrorClassification {
	action: SyncErrorAction
	error: unknown
	errorMessage: string
	errorStack?: string
}

export function classifySyncError(error: unknown, attemptCount: number, maxAttempts: number): SyncErrorClassification {
	const errorMessage = error instanceof Error ? error.message : String(error)
	const errorStack = error instanceof Error ? error.stack : undefined

	if (isSyncdMissingKeyError(error)) {
		return { action: SyncErrorAction.BLOCK_ON_KEY, error, errorMessage, errorStack }
	}

	const isTypeError = error instanceof Error && error.name === 'TypeError'
	if (isTypeError || attemptCount >= maxAttempts) {
		return { action: SyncErrorAction.ABORT, error, errorMessage, errorStack }
	}

	return { action: SyncErrorAction.RETRY, error, errorMessage, errorStack }
}

export interface CollectionSyncState {
	name: WAPatchName
	state: LTHashState
	isNewSync: boolean
}

export function prepareCollectionSyncNode(name: WAPatchName, state: LTHashState): BinaryNode {
	return {
		tag: 'collection',
		attrs: {
			name,
			version: state.version.toString(),
			return_snapshot: (!state.version).toString()
		}
	}
}

export function prepareCollectionSyncNodes(collections: readonly CollectionSyncState[]): BinaryNode[] {
	return collections.map(({ name, state }) => prepareCollectionSyncNode(name, state))
}
