import { Mutex } from 'async-mutex'
import { InMemoryStorageWithMaxItens } from './cache'
import { ILogger } from './logger'

type MutexEntry = {
	mutex: Mutex
	refCount: number
}

export class MutexWithRefCount {
	private mutex = new InMemoryStorageWithMaxItens<MutexEntry>(15)

	constructor(public logger: ILogger) {}

	getMutexByKey = (key: string): MutexEntry => {
		let mutex = this.mutex.get(key)
		if (!mutex) {
			mutex = {
				mutex: new Mutex(),
				refCount: 0
			}
			this.mutex.set(key, mutex)

			this.logger.info({ key }, 'created new sender key mutex')
		}

		return mutex
	}

	acquireSenderKey = (key: string) => {
		const entry = this.getMutexByKey(key)
		if (entry) {
			this.logger.trace({ key, refCount: entry.refCount }, 'acquiring sender key mutex')
			entry.refCount += 1
		}
	}

	releaseSenderKey = (name: string) => {
		const data = this.mutex.get(name)

		if (!data) return

		const count = (data.refCount ?? 1) - 1
		data.refCount = count

		if (count <= 0) {
			if (data && !data.mutex.isLocked()) {
				// safe cleanup
				this.logger.trace({ name }, 'cleaning up sender key mutex')
				this.mutex.delete(name)
			}
		}
	}

	runMutexWithAcquire = async <T>(key: string, op: () => Promise<T>): Promise<T> => {
		const mutex = this.getMutexByKey(key)
		this.acquireSenderKey(key)

		try {
			return await mutex.mutex.runExclusive(op)
		} finally {
			this.releaseSenderKey(key)
		}
	}
}
