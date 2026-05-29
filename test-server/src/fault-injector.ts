/**
 * fault-injector.ts — deterministic network/protocol fault injection for
 * the fake WhatsApp server. Backed by a seedable PRNG so any reproduction
 * of a race condition is bit-for-bit identical when re-run with the same
 * seed and config.
 */

import type { BinaryNode } from '../../src/WABinary'

/**
 * Mulberry32 PRNG — small, fast, deterministic. 2^32-period is plenty for
 * test-grade fuzzing.
 */
const mulberry32 = (seed: number): (() => number) => {
	let a = seed >>> 0
	return (): number => {
		a = (a + 0x6d2b79f5) >>> 0
		let t = a
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
	}
}

export type FaultDirection = 'inbound' | 'outbound'

export type FaultConfig = {
	/** PRNG seed. Same seed + same workload ⇒ same faults. */
	seed: number
	/** Probability (0–1) that a frame is silently dropped. */
	dropProbability: number
	/** Probability (0–1) that a frame is sent twice to the peer. */
	duplicateProbability: number
	/** Probability (0–1) that a frame is delayed before delivery, swapping the
	 *  effective order of subsequent frames on the same connection. */
	reorderProbability: number
	/** Latency range applied to every delivered frame. */
	minLatencyMs: number
	maxLatencyMs: number
	/** Extra synthetic CPU cost charged to the processing pipeline (ms). */
	slowProcessingMs: number
	/** Probability (0–1) of forcibly closing a healthy connection per frame. */
	disconnectProbability: number
	/** Probability (0–1) of an intermittent error reply (`<iq type=error/>`)
	 *  for any inbound iq. */
	intermittentErrorProbability: number
	/** Probability (0–1) that an *outbound* frame has its AES-GCM ciphertext
	 *  tampered with before sending, which triggers a Bad-MAC / decryption
	 *  failure on the client and causes the Noise transport to tear down. */
	corruptProbability: number
	/** Probability (0–1) that any `<enc>` payload nested inside an outbound
	 *  node has the trailing byte of its content flipped before the frame is
	 *  Noise-encoded. The Noise transport on the receiver decodes the frame
	 *  normally, but the embedded Signal ciphertext fails HMAC verification,
	 *  producing a real libsignal Bad-MAC error. */
	corruptSignalProbability: number
	/** Optional decision filter — return `'allow' | 'drop' | 'duplicate' |
	 *  'reorder' | 'disconnect' | 'error' | 'corrupt'` to override the random
	 *  outcome. */
	decider?: (ctx: FaultContext) => FaultDecision | undefined
}

export type FaultContext = {
	direction: FaultDirection
	clientId: string
	node?: BinaryNode
}

export type FaultDecision =
	| 'allow'
	| 'drop'
	| 'duplicate'
	| 'reorder'
	| 'disconnect'
	| 'error'
	| 'corrupt'
	| 'corruptSignal'

export const defaultFaultConfig = (): FaultConfig => ({
	seed: 1,
	dropProbability: 0,
	duplicateProbability: 0,
	reorderProbability: 0,
	minLatencyMs: 0,
	maxLatencyMs: 0,
	slowProcessingMs: 0,
	disconnectProbability: 0,
	intermittentErrorProbability: 0,
	corruptProbability: 0,
	corruptSignalProbability: 0
})

export class FaultInjector {
	private readonly rng: () => number
	private readonly cfg: FaultConfig

	constructor(cfg: Partial<FaultConfig> = {}) {
		this.cfg = { ...defaultFaultConfig(), ...cfg }
		this.rng = mulberry32(this.cfg.seed)
	}

	get config(): Readonly<FaultConfig> {
		return this.cfg
	}

	/**
	 * Computes a network latency in ms to apply to a frame in either
	 * direction. Returns 0 when no latency is configured.
	 */
	latencyMs(): number {
		const { minLatencyMs, maxLatencyMs } = this.cfg
		if (maxLatencyMs <= 0 && minLatencyMs <= 0) {
			return 0
		}
		const lo = Math.max(0, minLatencyMs)
		const hi = Math.max(lo, maxLatencyMs)
		return lo + Math.floor(this.rng() * (hi - lo + 1))
	}

	processingMs(): number {
		return Math.max(0, this.cfg.slowProcessingMs)
	}

	/** Decide what to do with a single frame. */
	decide(ctx: FaultContext): FaultDecision {
		if (this.cfg.decider) {
			const forced = this.cfg.decider(ctx)
			if (forced) {
				return forced
			}
		}
		const r = this.rng()
		let acc = 0
		if (r < (acc += this.cfg.dropProbability)) {
			return 'drop'
		}
		if (r < (acc += this.cfg.duplicateProbability)) {
			return 'duplicate'
		}
		if (r < (acc += this.cfg.reorderProbability)) {
			return 'reorder'
		}
		if (r < (acc += this.cfg.disconnectProbability)) {
			return 'disconnect'
		}
		if (r < (acc += this.cfg.intermittentErrorProbability)) {
			return 'error'
		}
		if (r < (acc += this.cfg.corruptProbability)) {
			return 'corrupt'
		}
		if (r < (acc += this.cfg.corruptSignalProbability)) {
			return 'corruptSignal'
		}
		return 'allow'
	}
}

export const sleep = (ms: number): Promise<void> =>
	ms <= 0 ? Promise.resolve() : new Promise(res => setTimeout(res, ms))
