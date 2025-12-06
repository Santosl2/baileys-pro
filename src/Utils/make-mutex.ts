import { Mutex as AsyncMutex } from 'async-mutex'

export const makeMutex = () => {
	const mutex = new AsyncMutex()
	return {
		mutex<T>(code: () => Promise<T> | T): Promise<T> {
			return mutex.runExclusive(code)
		}
	}
}

export type Mutex = ReturnType<typeof makeMutex>

export const makeKeyedMutex = () => {
	const map: { [id: string]: AsyncMutex } = {}
	const refCounts: { [id: string]: number } = {}

	return {
		async mutex<T>(key: string, task: () => Promise<T> | T): Promise<T> {
			// Create mutex if it doesn't exist
			if (!map[key]) {
				map[key] = new AsyncMutex()
				refCounts[key] = 0
			}

			// Increment reference count
			refCounts[key]++

			try {
				return await map[key].runExclusive(task)
			} finally {
				// Decrement reference count
				refCounts[key]--

				// Clean up if no one is waiting and mutex is not locked
				if (refCounts[key] === 0 && !map[key].isLocked()) {
					delete map[key]
					delete refCounts[key]
				}
			}
		}
	}
}

export type KeyedMutex = ReturnType<typeof makeKeyedMutex>
