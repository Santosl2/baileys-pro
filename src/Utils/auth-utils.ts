import NodeCache from '@cacheable/node-cache'
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
				for (const id of ids) {
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

				await cacheMset(toSave)

				logger?.trace({ keys }, 'updated cache')
				await store.set(data)
			})
		},
		async clear() {
			logger?.info('clearing signal store cache')
			await cache.flushAll()
			await store.clear?.()
		}
	}
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
	let inTransaction = false
	// number of queries made to the DB during the transaction
	// only there for logging purposes
	let dbQueriesInTransaction = 0
	let transactionCache: SignalDataSet = {}
	let mutations: SignalDataSet = {}

	/**
	 * prefetches some data and stores in memory,
	 * useful if these data points will be used together often
	 * */
	const prefetch = async (type: keyof SignalDataTypeMap, ids: string[]) => {
		const dict = transactionCache[type]
		const idsRequiringFetch = dict ? ids.filter(item => !(item in dict)) : ids
		// only fetch if there are any items to fetch
		if (idsRequiringFetch.length) {
			dbQueriesInTransaction += 1
			const result = await state.get(type, idsRequiringFetch)

			//@ts-ignore
			transactionCache[type] = Object.assign(transactionCache[type] || {}, result)
		}
	}

	return {
		get: async (type, ids) => {
			if (inTransaction) {
				await prefetch(type, ids)
				return ids.reduce((dict, id) => {
					const value = transactionCache[type]?.[id]
					if (value) {
						dict[id] = value
					}

					return dict
				}, {})
			} else {
				return state.get(type, ids)
			}
		},
		set: data => {
			if (inTransaction) {
				logger.trace({ types: Object.keys(data) }, 'caching in transaction')
				for (const key in data) {
					transactionCache[key] = transactionCache[key] || {}
					Object.assign(transactionCache[key], data[key])

					mutations[key] = mutations[key] || {}
					Object.assign(mutations[key], data[key])
				}
			} else {
				return state.set(data)
			}
		},
		isInTransaction: () => inTransaction,
		async transaction<T>(work: () => Promise<T>): Promise<T> {
			// if we're already in a transaction,
			// just execute what needs to be executed -- no commit required
			if (inTransaction) {
				return work()
			} else {
				logger.trace('entering transaction')
				inTransaction = true
				try {
					const result = await work()
					if (Object.keys(mutations).length) {
						logger.trace('committing transaction')
						// retry mechanism to ensure we've some recovery
						// in case a transaction fails in the first attempt
						let tries = maxCommitRetries
						while (tries) {
							tries -= 1
							// eslint-disable-next-line max-depth
							try {
								await state.set(mutations)
								logger.trace({ dbQueriesInTransaction }, 'committed transaction')
								break
							} catch (error) {
								logger.warn(`failed to commit ${Object.keys(mutations).length} mutations, tries left=${tries}`)
								await delay(delayBetweenTriesMs)
							}
						}
					} else {
						logger.trace('no mutations in transaction')
					}

					return result
				} finally {
					inTransaction = false
					transactionCache = {}
					mutations = {}
					dbQueriesInTransaction = 0
				}
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
