/**
 * metrics.ts — in-memory counters & timing histograms for the fake server.
 * Designed to be zero-allocation in the hot path.
 */

export type CounterName =
	| 'connections.opened'
	| 'connections.closed'
	| 'connections.rejected'
	| 'handshakes.completed'
	| 'handshakes.failed'
	| 'frames.in'
	| 'frames.out'
	| 'frames.dropped'
	| 'frames.duplicated'
	| 'frames.reordered'
	| 'frames.corrupted'
	| 'signal.corrupted'
	| 'iqs.handled'
	| 'iqs.errored'
	| 'forced.disconnects'

export type EventRecord = {
	ts: number
	clientId: string
	kind: string
	tag?: string
	id?: string
	extra?: Record<string, unknown>
}

export class Metrics {
	private readonly counters = new Map<CounterName, number>()
	private readonly latencies: number[] = []
	private readonly events: EventRecord[] = []
	private readonly maxEvents: number

	constructor(maxEvents = 10_000) {
		this.maxEvents = maxEvents
	}

	inc(name: CounterName, by = 1): void {
		this.counters.set(name, (this.counters.get(name) ?? 0) + by)
	}

	get(name: CounterName): number {
		return this.counters.get(name) ?? 0
	}

	recordLatency(ms: number): void {
		this.latencies.push(ms)
	}

	record(event: EventRecord): void {
		if (this.events.length >= this.maxEvents) {
			this.events.shift()
		}
		this.events.push(event)
	}

	snapshot(): {
		counters: Record<string, number>
		latency: { count: number; min: number; max: number; mean: number; p95: number; p99: number }
		events: ReadonlyArray<EventRecord>
	} {
		const counters: Record<string, number> = {}
		for (const [k, v] of this.counters) {
			counters[k] = v
		}

		const sorted = [...this.latencies].sort((a, b) => a - b)
		const pct = (p: number): number => {
			if (sorted.length === 0) {
				return 0
			}
			const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
			return sorted[idx]!
		}
		const sum = sorted.reduce((acc, n) => acc + n, 0)
		const latency = {
			count: sorted.length,
			min: sorted[0] ?? 0,
			max: sorted[sorted.length - 1] ?? 0,
			mean: sorted.length === 0 ? 0 : sum / sorted.length,
			p95: pct(95),
			p99: pct(99)
		}
		return { counters, latency, events: this.events }
	}

	reset(): void {
		this.counters.clear()
		this.latencies.length = 0
		this.events.length = 0
	}
}
