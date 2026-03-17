import { Mutex } from 'async-mutex'
import { SignalDataSet, SignalDataTypeMap, SignalKeyStore } from '../Types'
import logger, { ILogger } from './logger'

export type PreKeyType = keyof SignalDataTypeMap & 'signed-pre-key'
/**
 * Handles pre-key operations with mutex protection
 */
export class PreKeyManager {
	private preKeyMutex = new Mutex()
	private signedPreKeyMutex = new Mutex()
	private readonly logger: ILogger

	constructor(logger: ILogger) {
		this.logger = logger
	}

	getPreKeyMutex(type: PreKeyType): Mutex {
		return type === 'signed-pre-key' ? this.signedPreKeyMutex : this.preKeyMutex
	}

	async handlePreKeyOperations({
		data,
		isInTransaction,
		mutations,
		transactionCache,
		keyType,
		state
	}: {
		data: SignalDataSet
		keyType: PreKeyType
		transactionCache: SignalDataSet
		mutations: SignalDataSet
		isInTransaction: boolean
		state?: SignalKeyStore
	}): Promise<void> {
		const mutex = this.getPreKeyMutex(keyType)

		await mutex.runExclusive(async () => {
			const keyData = data[keyType] as Record<string, unknown> | undefined
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
				;(transactionCache[keyType] as Record<string, unknown>)[keyId] = keyData[keyId]
				;(mutations[keyType] as Record<string, unknown>)[keyId] = keyData[keyId]
			}

			// Process deletions with validation
			if (deletionKeys.length === 0) return

			if (isInTransaction) {
				// In transaction, only allow deletion if key exists in cache
				for (const keyId of deletionKeys) {
					if (transactionCache[keyType][keyId]) {
						;(transactionCache[keyType] as Record<string, unknown>)[keyId] = null
						;(mutations[keyType] as Record<string, unknown>)[keyId] = null
					} else {
						this.logger.warn(`Skipping deletion of non-existent ${keyType} in transaction: ${keyId}`)
					}
				}

				return
			}

			// Outside transaction, batch validate all deletions
			if (!state) return

			const existingKeys = await state.get(keyType as keyof SignalDataTypeMap, deletionKeys)
			for (const keyId of deletionKeys) {
				if (existingKeys[keyId]) {
					;(transactionCache[keyType] as Record<string, unknown>)[keyId] = null
					;(mutations[keyType] as Record<string, unknown>)[keyId] = null
				} else {
					logger.warn(`Skipping deletion of non-existent ${keyType}: ${keyId}`)
				}
			}
		})
	}

	async handlePreKeyDeletions({
		data,
		keyType,
		state
	}: {
		data: SignalDataSet
		keyType: string
		state: SignalKeyStore
	}): Promise<void> {
		const mutex = this.getPreKeyMutex(keyType as PreKeyType)
		await mutex.runExclusive(async () => {
			const keyData = data[keyType]

			if (!keyData) return

			try {
				await Promise.all(
					Object.keys(keyData).map(async keyId => {
						if (keyData[keyId] === null) {
							const existingKeys = await state.get(keyType as keyof SignalDataTypeMap, [keyId])
							if (!existingKeys[keyId]) {
								this.logger.warn(`Skipping deletion of non-existent ${keyType}: ${keyId}`)
								delete data[keyType][keyId]
							}
						}
					})
				)
			} catch (error) {
				this.logger.error(`Error during pre-key deletion validation for ${keyType}: ${error}`)
				throw error
			}
		})
	}
}
