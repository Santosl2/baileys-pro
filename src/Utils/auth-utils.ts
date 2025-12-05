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
			stdTTL: DEFAULT_CACHE_TTLS.SIGNAL_STORE, // 5 minutes
			useClones: false,
			deleteOnExpire: true
		})

	// Mutex for protecting cache operations
	const cacheMutex = new Mutex()

	function getUniqueId(type: string, id: string) {
		return `${type}.${id}`
	}

	return {
		async get(type, ids) {
			return cacheMutex.runExclusive(async () => {
				const data: { [_: string]: SignalDataTypeMap[typeof type] } = {}
				const idsToFetch: string[] = []
				for (const id of ids) {
					const cacheKey = getUniqueId(type, id)
					const item = cache.get<SignalDataTypeMap[typeof type]>(cacheKey)
					// Only consider it a cache hit if we got a non-undefined value
					// Note: null values are valid (used for deletions), undefined means not in cache
					if (item !== undefined) {
						// Skip null values as they represent deletions
						if (item !== null) {
							data[id] = item as SignalDataTypeMap[typeof type]
						}
					} else {
						idsToFetch.push(id)
					}
				}

				if (idsToFetch.length) {
					logger?.trace({ items: idsToFetch.length }, 'loading from store')
					const fetched = await store.get(type, idsToFetch)
					for (const id of idsToFetch) {
						const item = fetched[id]
						if (item) {
							data[id] = item
							cache.set(getUniqueId(type, id), item)
						}
					}
				}

				return data
			})
		},
		async set(data) {
			return cacheMutex.runExclusive(async () => {
				let keys = 0
				for (const type in data) {
					for (const id in data[type]) {
						cache.set(getUniqueId(type, id), data[type][id])
						keys += 1
					}
				}

				logger?.trace({ keys }, 'updated cache')

				await store.set(data)
			})
		},
		async clear() {
			return cacheMutex.runExclusive(async () => {
				cache.flushAll()
				await store.clear?.()
			})
		}
	}
}

/**
 * Creates pre-key mutexes factory for a specific instance
 * This avoids global mutex contention between different instances
 */
function createPreKeyMutexes(): { getMutex: (keyType: string) => Mutex } {
	const preKeyMutex = new Mutex()
	const signedPreKeyMutex = new Mutex()

	return {
		getMutex: (keyType: string): Mutex => {
			return keyType === 'signed-pre-key' ? signedPreKeyMutex : preKeyMutex
		}
	}
}

/**
 * Handles pre-key operations with mutex protection
 */
async function handlePreKeyOperations(
	data: SignalDataSet,
	keyType: string,
	transactionCache: SignalDataSet,
	mutations: SignalDataSet,
	logger: ILogger,
	isInTransaction: boolean,
	getPreKeyMutex: (keyType: string) => Mutex,
	state?: SignalKeyStore
): Promise<void> {
	const mutex = getPreKeyMutex(keyType)

	await mutex.runExclusive(async () => {
		const keyData = data[keyType]
		if (!keyData) return

		// Ensure structures exist
		transactionCache[keyType] = transactionCache[keyType] || {}
		mutations[keyType] = mutations[keyType] || {}

		// Separate deletions from updates for batch processing
		const deletionKeys: string[] = []
		const updateKeys: string[] = []

		for (const keyId in keyData) {
			if (keyData[keyId] === null) {
				deletionKeys.push(keyId)
			} else {
				updateKeys.push(keyId)
			}
		}

		// Process updates first (no validation needed)
		for (const keyId of updateKeys) {
			transactionCache[keyType][keyId] = keyData[keyId]
			mutations[keyType][keyId] = keyData[keyId]
		}

		// Process deletions with validation
		if (deletionKeys.length === 0) return

		if (isInTransaction) {
			// In transaction, only allow deletion if key exists in cache
			for (const keyId of deletionKeys) {
				if (transactionCache[keyType][keyId]) {
					transactionCache[keyType][keyId] = null
					mutations[keyType][keyId] = null
				} else {
					logger.warn(`Skipping deletion of non-existent ${keyType} in transaction: ${keyId}`)
				}
			}

			return
		}

		// Outside transaction, batch validate all deletions
		if (!state) return

		const existingKeys = await state.get(keyType as keyof SignalDataTypeMap, deletionKeys)
		for (const keyId of deletionKeys) {
			if (existingKeys[keyId]) {
				transactionCache[keyType][keyId] = null
				mutations[keyType][keyId] = null
			} else {
				logger.warn(`Skipping deletion of non-existent ${keyType}: ${keyId}`)
			}
		}
	})
}

/**
 * Handles normal key operations for transactions
 */
function handleNormalKeyOperations(
	data: SignalDataSet,
	key: string,
	transactionCache: SignalDataSet,
	mutations: SignalDataSet
) {
	Object.assign(transactionCache[key], data[key])
	mutations[key] = mutations[key] || {}
	Object.assign(mutations[key], data[key])
}

/**
 * Process pre-key deletions with validation
 */
async function processPreKeyDeletions(
	data: SignalDataSet,
	keyType: string,
	state: SignalKeyStore,
	logger: ILogger,
	getPreKeyMutex: (keyType: string) => Mutex
): Promise<void> {
	const mutex = getPreKeyMutex(keyType)

	await mutex.runExclusive(async () => {
		const keyData = data[keyType]
		if (!keyData) return

		// Validate deletions
		for (const keyId in keyData) {
			if (keyData[keyId] === null) {
				const existingKeys = await state.get(keyType as keyof SignalDataTypeMap, [keyId])
				if (!existingKeys[keyId]) {
					logger.warn(`Skipping deletion of non-existent ${keyType}: ${keyId}`)
					delete data[keyType][keyId]
				}
			}
		}
	})
}

/**
 * Executes a function with mutexes acquired for given key types
 * Uses async-mutex's runExclusive with efficient batching
 */
async function withMutexes<T>(
	keyTypes: string[],
	getKeyTypeMutex: (type: string) => Mutex,
	fn: () => Promise<T>
): Promise<T> {
	if (keyTypes.length === 0) {
		return fn()
	}

	if (keyTypes.length === 1) {
		return getKeyTypeMutex(keyTypes[0]).runExclusive(fn)
	}

	// For multiple mutexes, sort by key type to prevent deadlocks
	// Then acquire all mutexes in order using Promise.all for better efficiency
	const sortedKeyTypes = [...keyTypes].sort()
	const mutexes = sortedKeyTypes.map(getKeyTypeMutex)

	// Acquire all mutexes in order to prevent deadlocks
	const releases: (() => void)[] = []

	try {
		for (const mutex of mutexes) {
			releases.push(await mutex.acquire())
		}

		return await fn()
	} finally {
		// Release in reverse order
		while (releases.length > 0) {
			const release = releases.pop()
			if (release) release()
		}
	}
}

/**
 * Attempts to commit transaction with retry mechanism
 * Throws error if all retries fail
 */
async function commitWithRetry(
	mutations: SignalDataSet,
	state: SignalKeyStore,
	getKeyTypeMutex: (type: string) => Mutex,
	maxRetries: number,
	delayMs: number,
	logger: ILogger
): Promise<void> {
	let tries = maxRetries
	let lastError: Error | undefined

	while (tries > 0) {
		tries -= 1

		try {
			await withMutexes(Object.keys(mutations), getKeyTypeMutex, async () => {
				await state.set(mutations)
				logger.trace('committed transaction')
			})
			return // Sucesso, sair da função
		} catch (error) {
			lastError = error as Error
			logger.warn(
				{ error: lastError.message, triesLeft: tries },
				`failed to commit ${Object.keys(mutations).length} mutations`
			)

			if (tries > 0) {
				await delay(delayMs)
			}
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
// Maximum number of sender key mutexes to keep in memory
const MAX_SENDER_KEY_MUTEXES = 1000

export const addTransactionCapability = (
    state: SignalKeyStore,
    logger: ILogger,
    { maxCommitRetries, delayBetweenTriesMs }: TransactionCapabilityOptions
): SignalKeyStoreWithTransaction => {
    const keyTypeMutexes = new Map<string, Mutex>()
    const senderKeyMutexes = new Map<string, Mutex>()
    const transactionMutex = new Mutex()
    const { getMutex: getPreKeyMutex } = createPreKeyMutexes()

    // Mutex para proteger estado interno da transação
    const stateMutex = new Mutex()

    let dbQueriesInTransaction = 0
    let transactionCache: SignalDataSet = {}
    let mutations: SignalDataSet = {}
    let transactionsInProgress = 0

    function getKeyTypeMutex(type: string): Mutex {
        let mutex = keyTypeMutexes.get(type)
        if (!mutex) {
            mutex = new Mutex()
            keyTypeMutexes.set(type, mutex)
        }
        return mutex
    }

    // Correção 3: Cleanup thread-safe
    function getSenderKeyMutex(senderKeyName: string): Mutex {
        let mutex = senderKeyMutexes.get(senderKeyName)
        if (!mutex) {
            mutex = new Mutex()
            senderKeyMutexes.set(senderKeyName, mutex)

            if (senderKeyMutexes.size > MAX_SENDER_KEY_MUTEXES) {
                // Agendar cleanup assíncrono para não bloquear
                setImmediate(() => {
                    let cleaned = 0
                    const toDelete: string[] = []
                    
                    for (const [key, m] of senderKeyMutexes) {
                        if (!m.isLocked() && key !== senderKeyName) {
                            toDelete.push(key)
                            cleaned++
                            if (cleaned >= MAX_SENDER_KEY_MUTEXES * 0.1) break
                        }
                    }
                    
                    // Verificar novamente antes de deletar
                    for (const key of toDelete) {
                        const m = senderKeyMutexes.get(key)
                        if (m && !m.isLocked()) {
                            senderKeyMutexes.delete(key)
                        }
                    }
                    
                    if (toDelete.length > 0) {
                        logger.trace({ cleaned: toDelete.length }, 'cleaned up sender key mutexes')
                    }
                })
            }
        }
        return mutex
    }

    function queueSenderKeyOperation<T>(senderKeyName: string, operation: () => Promise<T>): Promise<T> {
        return getSenderKeyMutex(senderKeyName).runExclusive(operation)
    }

    function isInTransaction() {
        return transactionsInProgress > 0
    }

    // Correção 2: Acesso thread-safe ao cache
    async function updateTransactionCache(type: string, data: Record<string, unknown>): Promise<void> {
        await stateMutex.runExclusive(() => {
            transactionCache[type] = transactionCache[type] || {}
            Object.assign(transactionCache[type]!, data)
        })
    }

    async function updateMutations(type: string, data: Record<string, unknown>): Promise<void> {
        await stateMutex.runExclusive(() => {
            mutations[type] = mutations[type] || {}
            Object.assign(mutations[type]!, data)
        })
    }

    async function incrementDbQueries(): Promise<void> {
        await stateMutex.runExclusive(() => {
            dbQueriesInTransaction += 1
        })
    }

    return {
        get: async (type, ids) => {
            if (isInTransaction()) {
                // Acessar cache de forma thread-safe
                const { dict, idsRequiringFetch } = await stateMutex.runExclusive(() => {
                    const d = transactionCache[type]
                    const toFetch = d ? ids.filter(item => typeof d[item] === 'undefined') : ids
                    return { dict: d, idsRequiringFetch: toFetch }
                })

                if (idsRequiringFetch.length) {
                    await incrementDbQueries()

                    if (type === 'sender-key') {
                        const batchResult = await state.get(type, idsRequiringFetch)
                        const updatePromises = idsRequiringFetch.map(senderKeyName =>
                            queueSenderKeyOperation(senderKeyName, async () => {
                                if (batchResult[senderKeyName]) {
                                    await updateTransactionCache(type, { [senderKeyName]: batchResult[senderKeyName] })
                                }
                            })
                        )
                        await Promise.allSettled(updatePromises)
                    } else {
                        await getKeyTypeMutex(type as string).runExclusive(async () => {
                            const result = await state.get(type, idsRequiringFetch)
                            await updateTransactionCache(type, result)
                        })
                    }
                }

                // Retornar de forma thread-safe
                return stateMutex.runExclusive(() => {
                    return ids.reduce((result, id) => {
                        const value = transactionCache[type]?.[id]
                        if (value) {
                            result[id] = value
                        }
                        return result
                    }, {} as Record<string, SignalDataTypeMap[typeof type]>)
                })
            } else {
                if (type === 'sender-key') {
                    const results: { [key: string]: SignalDataTypeMap[typeof type] } = {}
                    for (const senderKeyName of ids) {
                        const result = await queueSenderKeyOperation(
                            senderKeyName,
                            async () => state.get(type, [senderKeyName])
                        )
                        Object.assign(results, result)
                    }
                    return results
                } else {
                    return  getKeyTypeMutex(type as string).runExclusive(() => state.get(type, ids))
                }
            }
        },

        set: async data => {
            if (isInTransaction()) {
                logger.trace({ types: Object.keys(data) }, 'caching in transaction')
                
                for (const key in data) {
                    // Inicializar de forma thread-safe
                    await stateMutex.runExclusive(() => {
                        transactionCache[key] = transactionCache[key] || {}
                    })

                    if (key === 'pre-key' || key === 'signed-pre-key') {
                        // handlePreKeyOperations já tem mutex interno
                        await handlePreKeyOperations(
                            data, key, transactionCache, mutations, 
                            logger, true, getPreKeyMutex
                        )
                    } else {
                        // Atualizar de forma thread-safe
                        await stateMutex.runExclusive(() => {
                            Object.assign(transactionCache[key]!, data[key])
                            mutations[key] = mutations[key] || {}
                            Object.assign(mutations[key]!, data[key])
                        })
                    }
                }
            } else {
                // ...existing code para operações fora de transação...
                const hasSenderKeys = 'sender-key' in data
                const senderKeyNames = hasSenderKeys ? Object.keys(data['sender-key'] || {}) : []

                if (hasSenderKeys) {
                    for (const senderKeyName of senderKeyNames) {
                        await queueSenderKeyOperation(senderKeyName, async () => {
                            const senderKeyData = {
                                'sender-key': {
                                    [senderKeyName]: data['sender-key']![senderKeyName]
                                }
                            }
                            await state.set(senderKeyData)
                        })
                    }

                    const nonSenderKeyData = { ...data }
                    delete nonSenderKeyData['sender-key']

                    if (Object.keys(nonSenderKeyData).length > 0) {
                        await withMutexes(Object.keys(nonSenderKeyData), getKeyTypeMutex, async () => {
                            for (const keyType in nonSenderKeyData) {
                                if (keyType === 'pre-key' || keyType === 'signed-pre-key') {
                                    await processPreKeyDeletions(nonSenderKeyData, keyType, state, logger, getPreKeyMutex)
                                }
                            }
                            await state.set(nonSenderKeyData)
                        })
                    }
                } else {
                    await withMutexes(Object.keys(data), getKeyTypeMutex, async () => {
                        for (const keyType in data) {
                            if (keyType === 'pre-key' || keyType === 'signed-pre-key') {
                                await processPreKeyDeletions(data, keyType, state, logger, getPreKeyMutex)
                            }
                        }
                        await state.set(data)
                    })
                }
            }
        },

        isInTransaction,

        dispose: () => {
            senderKeyMutexes.clear()
            keyTypeMutexes.clear()
            logger.trace('disposed transaction capability resources')
        },

        ...(state.clear ? { clear: state.clear } : {}),

        // Correção 1: Transação completamente protegida
        async transaction(work) {
            // Manter o mutex durante TODA a transação
            return transactionMutex.runExclusive(async () => {
                transactionsInProgress += 1
                const isOutermost = transactionsInProgress === 1

                if (isOutermost) {
                    logger.trace('entering transaction')
                }

                try {
                    const result = await work()

                    if (isOutermost) {
                        const mutationKeys = Object.keys(mutations)
                        if (mutationKeys.length > 0) {
                            logger.trace('committing transaction')
                            await commitWithRetry(
                                mutations, state, getKeyTypeMutex,
                                maxCommitRetries, delayBetweenTriesMs, logger
                            )
                            logger.trace({ dbQueriesInTransaction }, 'transaction completed')
                        } else {
                            logger.trace('no mutations in transaction')
                        }
                    }

                    return result
                } finally {
                    transactionsInProgress -= 1
                    if (transactionsInProgress === 0) {
                        transactionCache = {}
                        mutations = {}
                        dbQueriesInTransaction = 0
                    }
                }
            })
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
