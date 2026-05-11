import NodeCache from '@cacheable/node-cache'
import { AsyncLocalStorage } from 'async_hooks'
import { Mutex } from 'async-mutex'
import { randomBytes } from 'crypto'
import { DEFAULT_CACHE_TTLS } from '../Defaults'
import type {
	AuthenticationCreds,
	CacheStore,
	SignalDataSet,
	SignalDataTypeMap,
	SignalKeyStore,
	SignalKeyStoreWithTransaction,
	TransactionCapabilityOptions
} from '../Types'
import { Curve, signedKeyPair } from './crypto'
import { delay, generateRegistrationId } from './generics'
import { ILogger } from './logger'
import { PreKeyManager } from './pre-key-manager'

/**
 * Adds caching capability to a SignalKeyStore
 * @param store the store to add caching to
 * @param logger to log trace events
 * @param _cache cache store to use
 */
export function makeCacheableSignalKeyStore(
	store: SignalKeyStore,
	logger?: ILogger,
	_cache?: CacheStore
): SignalKeyStore {
	const cache =
		_cache ||
		new NodeCache({
			stdTTL: DEFAULT_CACHE_TTLS.SIGNAL_STORE, // 10 minutes
			useClones: false,
			deleteOnExpire: true
		})

	// Mutex for protecting cache operations
	const cacheMutex = new Mutex()

	function getUniqueId(type: string, id: string) {
		return `${type}.${id}`
	}

	async function cacheGet<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
		const keys = ids.map(id => getUniqueId(type, id))

		if (cache.mget) {
			return cache.mget(keys) as unknown as Promise<Record<string, SignalDataTypeMap[T] | undefined>>
		}

		const results: Record<string, SignalDataTypeMap[T] | undefined> = {}

		for (const key of keys) {
			results[key] = (await cache.get(key)) as SignalDataTypeMap[T] | undefined
		}

		return results
	}

	type CacheValue = SignalDataTypeMap[keyof SignalDataTypeMap]

	async function cacheMset(entries: Array<{ key: string; value: CacheValue }>): Promise<void> {
		if (entries.length === 0) return

		if (cache.mset) {
			await cache.mset(entries)
		} else {
			for (const { key, value } of entries) {
				await cache.set(key, value)
			}
		}
	}

	return {
		async get(type, ids) {
			const data: { [_: string]: SignalDataTypeMap[typeof type] } = {}
			const idsToFetch: string[] = []

			const items = await cacheGet(type, ids)
			if (items) {
				for (let i = 0; i < ids.length; i++) {
					const id = ids[i]
					const item = items[getUniqueId(type, id)]
					if (typeof item !== 'undefined') {
						data[id] = item
					} else {
						idsToFetch.push(id)
					}
				}
			}

			if (idsToFetch.length) {
				logger?.trace({ items: idsToFetch.length }, 'loading from store')
				const fetched = await store.get(type, idsToFetch)
				const insertItems = idsToFetch
					.map(id => {
						const item = fetched[id]
						if (item) {
							data[id] = item

							return {
								key: getUniqueId(type, id),
								value: fetched[id] as SignalDataTypeMap[keyof SignalDataTypeMap]
							}
						}

						return undefined as any
					})
					.filter(Boolean)
				await cacheMset(insertItems)
			}

			return data
		},
		async set(data) {
			return cacheMutex.runExclusive(async () => {
				let keys = 0
				const toSave: {
					key: string
					value: SignalDataTypeMap[keyof SignalDataTypeMap]
				}[] = []

				for (const type in data) {
					const typedType = type as keyof SignalDataTypeMap

					for (const id in data[typedType]) {
						toSave.push({
							key: getUniqueId(type, id),
							value: data[typedType][id] as SignalDataTypeMap[keyof SignalDataTypeMap]
						})

						keys += 1
					}
				}

				logger?.trace({ keys }, 'updated cache')
				await Promise.allSettled([cacheMset(toSave), store.set(data)])
			})
		},
		async clear() {
			logger?.info('clearing signal store cache')
			await cache.flushAll()
			await store.clear?.()
		}
	}
}

interface TransactionContext {
	cache: SignalDataSet
	mutations: SignalDataSet
	dbQueries: number
}

/**
 * Adds DB like transaction capability (https://en.wikipedia.org/wiki/Database_transaction) to the SignalKeyStore,
 * this allows batch read & write operations & improves the performance of the lib
 * @param state the key store to apply this capability to
 * @param logger logger to log events
 * @returns SignalKeyStore with transaction capability
 */
export const addTransactionCapability = (
	state: SignalKeyStore,
	logger: ILogger,
	{ maxCommitRetries, delayBetweenTriesMs }: TransactionCapabilityOptions
): SignalKeyStoreWithTransaction => {
	const txStorage = new AsyncLocalStorage<TransactionContext>()

	// Queues for concurrency control (keyed by signal data type - bounded set)
	const keyQueues = new Map<string, Mutex>()

	// Transaction mutexes with reference counting for cleanup
	const txMutexes = new Map<string, Mutex>()
	const txMutexRefCounts = new Map<string, number>()

	// Pre-key manager for specialized operations
	const preKeyManager = new PreKeyManager(state, logger)

	/**
	 * Get or create a queue for a specific key type
	 */
	function getQueue(key: string): Mutex {
		let mutex = keyQueues.get(key)
		if (!mutex) {
			mutex = new Mutex()
			keyQueues.set(key, mutex)
		}

		return mutex
	}

	/**
	 * Get or create a transaction mutex
	 */
	function getTxMutex(key: string): Mutex {
		let mutex = txMutexes.get(key)
		if (!mutex) {
			mutex = new Mutex()
			txMutexes.set(key, mutex)
			txMutexRefCounts.set(key, 0)
		}

		return mutex
	}

	/**
	 * Acquire a reference to a transaction mutex
	 */
	function acquireTxMutexRef(key: string): void {
		const count = txMutexRefCounts.get(key) ?? 0
		txMutexRefCounts.set(key, count + 1)
	}

	/**
	 * Release a reference to a transaction mutex and cleanup if no longer needed
	 */
	function releaseTxMutexRef(key: string): void {
		const count = (txMutexRefCounts.get(key) ?? 1) - 1
		txMutexRefCounts.set(key, count)

		// Cleanup if no more references and mutex is not locked
		if (count <= 0) {
			const mutex = txMutexes.get(key)
			if (mutex && !mutex.isLocked()) {
				txMutexes.delete(key)
				txMutexRefCounts.delete(key)
			}
		}

		// for (const [mutexKey, mutex] of txMutexes) {
		// 	if (count <= 0 && !mutex.isLocked()) {
		// 		txMutexes.delete(mutexKey)
		// 		txMutexRefCounts.delete(mutexKey)
		// 		logger.trace(`cleaned up transaction mutex for key=${mutexKey}`)
		// 	}
		// }
	}

	/**
	 * Check if currently in a transaction
	 */
	function isInTransaction(): boolean {
		return !!txStorage.getStore()
	}

	/**
	 * Commit transaction with retries
	 */
	async function commitWithRetry(mutations: SignalDataSet): Promise<void> {
		const keys = Object.keys(mutations)
		if (keys.length === 0) {
			logger.trace('no mutations in transaction')
			return
		}

		logger.trace('committing transaction')

		for (let attempt = 0; attempt < maxCommitRetries; attempt++) {
			try {
				await state.set(mutations)
				logger.trace({ mutationCount: keys.length }, 'committed transaction')
				return
			} catch (error) {
				const retriesLeft = maxCommitRetries - attempt - 1
				logger.warn(`failed to commit mutations, retries left=${retriesLeft}`)

				if (retriesLeft === 0) {
					throw error
				}

				await delay(delayBetweenTriesMs)
			}
		}
	}

	return {
		get: async (type, ids) => {
			const ctx = txStorage.getStore()

			if (!ctx) {
				// No transaction - direct read without exclusive lock for concurrency
				return state.get(type, ids)
			}

			// In transaction - check cache first
			const cached = ctx.cache[type] || {}

			if (!ctx.cache[type]) {
				ctx.cache[type] = {}
			}

			const missing: string[] = []

			for (let i = 0; i < ids.length; i++) {
				const id = ids[i]
				if (cached[id] === undefined) missing.push(id)
			}

			if (missing.length > 0) {
				ctx.dbQueries++
				logger.trace({ type, count: missing.length }, 'fetching missing keys in transaction')

				const fetched = await state.get(type, missing)

				// Update cache
				for (const k in fetched) cached[k] = fetched[k]
			}

			// Return requested ids from cache
			const result: { [key: string]: any } = {}

			for (let i = 0; i < ids.length; i++) {
				const id = ids[i]
				const value = cached[id]
				if (value !== undefined && value !== null) {
					result[id] = value
				}
			}

			return result
		},

		set: async data => {
			const ctx = txStorage.getStore()

			if (!ctx) {
				// No transaction - direct write with queue protection
				const types = Object.keys(data)

				if (types.length === 1) {
					const type = types[0]
					if (type === 'pre-key') await preKeyManager.validateDeletions(data, type)
					return getQueue(type).runExclusive(() => state.set(data))
				}

				await Promise.allSettled(
					types.map(type =>
						getQueue(type)
							.runExclusive(async () => {
								if (type === 'pre-key') {
									await preKeyManager.validateDeletions(data, type)
								}

								return state.set({ [type]: data[type] })
							})
							.catch(error => {
								logger.error({ error, type }, 'failed to set data for type')
								throw error
							})
							.finally(() => {
								const isInUse = keyQueues.get(type)?.isLocked() ?? false

								if (!isInUse) {
									keyQueues.delete(type)
									logger.trace(`cleaned up queue for type=${type}`)
								}

								logger.trace({ type }, 'updated store outside of transaction')
							})
					)
				)

				return
			}

			// In transaction - update cache and mutations
			logger.trace({ types: Object.keys(data) }, 'caching in transaction')

			for (const key_ in data) {
				const key = key_ as keyof SignalDataTypeMap

				// Ensure structures exist
				ctx.cache[key] = ctx.cache[key] || ({} as any)
				ctx.mutations[key] = ctx.mutations[key] || ({} as any)

				// Special handling for pre-keys
				if (key === 'pre-key') {
					await preKeyManager.processOperations(data, key, ctx.cache, ctx.mutations, true)
				} else {
					// Normal key types
					Object.assign(ctx.cache[key]!, data[key])
					Object.assign(ctx.mutations[key]!, data[key])
				}
			}
		},

		isInTransaction,

		transaction: async (work, key) => {
			const existing = txStorage.getStore()

			// Nested transaction - reuse existing context
			if (existing) {
				logger.trace('reusing existing transaction context')
				return work()
			}

			// New transaction - acquire mutex and create context
			const mutex = getTxMutex(key)
			acquireTxMutexRef(key)

			try {
				return await mutex.runExclusive(async () => {
					const ctx: TransactionContext = {
						cache: {},
						mutations: {},
						dbQueries: 0
					}

					logger.trace('entering transaction')

					try {
						const result = await txStorage.run(ctx, work)

						// Commit mutations
						await commitWithRetry(ctx.mutations)

						logger.trace({ dbQueries: ctx.dbQueries }, 'transaction completed')

						return result
					} catch (error) {
						logger.error({ error }, 'transaction failed, rolling back')
						throw error
					}
				})
			} finally {
				releaseTxMutexRef(key)
			}
		}
	}
}

export const initAuthCreds = (): AuthenticationCreds => {
	const identityKey = Curve.generateKeyPair()
	return {
		noiseKey: Curve.generateKeyPair(),
		pairingEphemeralKeyPair: Curve.generateKeyPair(),
		signedIdentityKey: identityKey,
		signedPreKey: signedKeyPair(identityKey, 1),
		registrationId: generateRegistrationId(),
		advSecretKey: randomBytes(32).toString('base64'),
		processedHistoryMessages: [],
		nextPreKeyId: 1,
		firstUnuploadedPreKeyId: 1,
		accountSyncCounter: 0,
		accountSettings: {
			unarchiveChats: false
		},
		registered: false,
		pairingCode: undefined,
		lastPropHash: undefined,
		routingInfo: undefined
	}
}
