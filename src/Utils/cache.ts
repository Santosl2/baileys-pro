export class InMemoryStorageWithMaxItens<T> {
	protected storage: Map<string, T> = new Map()

	constructor(public maxItens = 200) {}

	set(key: string, message: T) {
		if (this.storage.size >= this.maxItens) {
			const oldestKey = this.storage.keys().next().value
			if (oldestKey) {
				this.storage.delete(oldestKey)
			}
		}

		this.storage.set(key, message)
	}

	get(id: string) {
		return this.storage.get(id)
	}

	has(id: string): boolean {
		return this.storage.has(id)
	}

	delete(id: string): boolean {
		return this.storage.delete(id)
	}

	clear() {
		this.storage.clear()
	}
}
