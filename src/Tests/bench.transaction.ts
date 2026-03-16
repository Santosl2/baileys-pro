/**
 * Benchmark: addTransactionCapability — memória e throughput
 *
 * Executar com:
 *   node --expose-gc -r ts-node/register src/Tests/bench.transaction.ts
 *
 * --expose-gc é obrigatório para forçar o GC e ter leituras de heap precisas.
 */

import { addTransactionCapability } from '../Utils'
import logger from '../Utils/logger'
import { makeMockSignalKeyStore } from './utils'

declare function gc(): void

// silencia logs durante o bench
logger.level = 'silent'

// ─── helpers ──────────────────────────────────────────────────────────────────

function heapMB(): number {
	return process.memoryUsage().heapUsed / 1024 / 1024
}

function forceGC() {
	if (typeof gc === 'function') {
		gc()
	} else {
		console.warn('[warn] gc() indisponível — execute com --expose-gc para leituras precisas')
	}
}

function printMemoryDiff(label: string, before: number, after: number) {
	const diff = after - before
	const sign = diff >= 0 ? '+' : ''
	console.log(`  ${label}: antes=${before.toFixed(2)} MB | depois=${after.toFixed(2)} MB | diff=${sign}${diff.toFixed(2)} MB`)
}

function makeStore() {
	return addTransactionCapability(makeMockSignalKeyStore(), logger, {
		maxCommitRetries: 3,
		delayBetweenTriesMs: 0
	})
}

// ─── teste 1: crescimento dos Maps internos (leak check) ──────────────────────

async function benchMapGrowth() {
	console.log('\n── Teste 1: crescimento de Maps internos ─────────────────────')

	// Acessa Maps internos via closure por reflexão não é possível diretamente,
	// então medimos indiretamente pelo heap após N transações com keys únicas.
	const store = makeStore()

	const TOTAL = 500
	const keys = Array.from({ length: TOTAL }, (_, i) => `jid-${i}@s.whatsapp.net`)

	forceGC()
	const heapBefore = heapMB()

	// cada chave única cria entradas nos Maps internos (txMutexes, txMutexRefCounts)
	for (const key of keys) {
		await store.transaction(async () => {
			await store.set({ session: { [key]: new Uint8Array(8) } })
		}, key)
	}

	forceGC()
	const heapAfter = heapMB()

	printMemoryDiff(`${TOTAL} transações com keys únicas`, heapBefore, heapAfter)

	// Critério: crescimento residual não deve passar de 2 MB para 500 chaves
	// (cada Mutex vazio é ~200 bytes; 500 entradas = ~100 KB esperado)
	const residual = heapAfter - heapBefore
	const status = residual < 2 ? '✅ PASS' : '❌ FAIL (possível leak)'
	console.log(`  resultado: ${status} (residual=${residual.toFixed(3)} MB)`)
}

// ─── teste 2: heap em carga sustentada de transações concorrentes ──────────────

async function benchConcurrentLoad() {
	console.log('\n── Teste 2: heap sob carga concorrente ────────────────────────')

	const store = makeStore()
	const ROUNDS = 5
	const CONCURRENT = 50

	const samples: number[] = []

	for (let round = 0; round < ROUNDS; round++) {
		forceGC()
		const before = heapMB()

		await Promise.all(
			Array.from({ length: CONCURRENT }, (_, i) =>
				store.transaction(async () => {
					await store.set({ session: { [`key-${i}`]: new Uint8Array(32) } })
					await store.get('session', [`key-${i}`])
				})
			)
		)

		forceGC()
		const after = heapMB()
		const diff = after - before
		samples.push(diff)
		process.stdout.write(`  round ${round + 1}/${ROUNDS}: diff=${diff >= 0 ? '+' : ''}${diff.toFixed(3)} MB\n`)
	}

	const avg = samples.reduce((a, b) => a + b, 0) / samples.length
	console.log(`  média de crescimento por round: ${avg >= 0 ? '+' : ''}${avg.toFixed(3)} MB`)
	const status = avg < 0.5 ? '✅ estável' : '⚠️  crescimento consistente'
	console.log(`  resultado: ${status}`)
}

// ─── teste 3: throughput (ops/sec) ────────────────────────────────────────────

async function benchThroughput() {
	console.log('\n── Teste 3: throughput ────────────────────────────────────────')

	const store = makeStore()
	const OPS = 1000

	// warm-up
	for (let i = 0; i < 20; i++) {
		await store.transaction(async () => {
			await store.set({ session: { warmup: new Uint8Array(4) } })
		})
	}

	const start = performance.now()

	for (let i = 0; i < OPS; i++) {
		await store.transaction(async () => {
			await store.set({ session: { [`k${i}`]: new Uint8Array(4) } })
			await store.get('session', [`k${i}`])
		})
	}

	const elapsed = performance.now() - start
	const opsPerSec = (OPS / elapsed) * 1000

	console.log(`  ${OPS} transações sequenciais em ${elapsed.toFixed(1)} ms`)
	console.log(`  throughput: ${opsPerSec.toFixed(0)} ops/sec`)
}

// ─── teste 4: leituras fora de transação (caminho direto) ─────────────────────

async function benchDirectReads() {
	console.log('\n── Teste 4: leituras diretas (sem transação) ──────────────────')

	const store = makeStore()

	// popula store
	await store.set({ session: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, new Uint8Array(8)])) })

	const OPS = 2000
	const start = performance.now()

	for (let i = 0; i < OPS; i++) {
		await store.get('session', [`k${i % 200}`])
	}

	const elapsed = performance.now() - start
	console.log(`  ${OPS} leituras diretas em ${elapsed.toFixed(1)} ms (${((OPS / elapsed) * 1000).toFixed(0)} ops/sec)`)
}

// ─── runner ───────────────────────────────────────────────────────────────────

async function main() {
	console.log('=== Benchmark: addTransactionCapability ===')
	console.log(`Node ${process.version} | ${new Date().toISOString()}`)

	forceGC()
	const baselineHeap = heapMB()
	console.log(`\nheap baseline: ${baselineHeap.toFixed(2)} MB`)

	await benchMapGrowth()
	await benchConcurrentLoad()
	await benchThroughput()
	await benchDirectReads()

	forceGC()
	const finalHeap = heapMB()
	console.log(`\n── heap final: ${finalHeap.toFixed(2)} MB (baseline era ${baselineHeap.toFixed(2)} MB)`)
	console.log('=== fim ===')
}

main().catch(e => {
	console.error(e)
	process.exit(1)
})
