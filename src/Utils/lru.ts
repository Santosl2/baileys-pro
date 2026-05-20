import { LRUCache } from 'lru-cache'
import { CacheStore } from '../Types'

export function createLruWithInterface(data: { max?: number; ttl?: number } = {}): CacheStore {
	const cache = new LRUCache<string, any>({
		max: data.max || 1000,
		ttl: data.ttl || 60 * 60 * 1000 // 1 hour
	})

	return {
		get: <T>(key: string) => cache.get(key) as T | undefined,
		set: <T>(key: string, value: T) => cache.set(key, value),
		del: (key: string) => cache.delete(key),
		flushAll: () => cache.clear(),
		close: () => cache.clear()
	}
}
