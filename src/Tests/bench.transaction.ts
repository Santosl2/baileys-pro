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

async function forceGC() {
	if (typeof gc === 'function') {
		gc()
		// Aguarda microtasks e um tick do event loop para o GC finalizar
		await new Promise(r => setTimeout(r, 100))
	} else {
		console.warn('[warn] gc() indisponível — execute com --expose-gc para leituras precisas')
	}
}

function printMemoryDiff(label: string, before: number, after: number) {
	const diff = after - before
	const sign = diff >= 0 ? '+' : ''
	console.log(`  ${label}: antes=${before.toFixed(2)} MB | depois=${after.toFixed(2)} MB | diff=${sign}${diff.toFixed(3)} MB`)
}

function makeStore() {
	return addTransactionCapability(makeMockSignalKeyStore(), logger, {
		maxCommitRetries: 3,
		delayBetweenTriesMs: 0
	})
}

// ─── teste 1: crescimento de Maps internos (leak check) ───────────────────────
//
// Verifica se mutexes e entradas criadas por keys únicas são corretamente
// liberados após o término das transações (sem leak no MutexWithRefCount /
// txMutexes). O heap deve retornar próximo ao baseline após o GC.

async function benchMapGrowth() {
	console.log('\n── Teste 1: crescimento de Maps internos ─────────────────────')

	const store = makeStore()

	const TOTAL = 500
	const keys = Array.from({ length: TOTAL }, (_, i) => `jid-${i}@s.whatsapp.net`)

	await forceGC()
	const heapBefore = heapMB()

	// Cada chave única cria entradas nos Maps internos (txMutexes, keyTypeMutexes).
	// Após o GC, entradas com refCount=0 devem ter sido removidas.
	for (const key of keys) {
		await store.transaction(async () => {
			await store.set({ session: { [key]: new Uint8Array(8) } })
		}, key)
	}

	await forceGC()
	const heapAfter = heapMB()

	printMemoryDiff(`${TOTAL} transações com keys únicas`, heapBefore, heapAfter)

	// Critério: crescimento residual < 2 MB para 500 chaves.
	// Um Mutex vazio ocupa ~200 bytes; 500 entradas = ~100 KB esperado.
	// Mais que 2 MB indica que as entradas NÃO estão sendo limpas (leak real).
	const residual = heapAfter - heapBefore
	const status = residual < 2 ? '✅ PASS' : '❌ FAIL (possível leak)'
	console.log(`  resultado: ${status} (residual=${residual.toFixed(3)} MB)`)
}

// ─── teste 1b: validação de cleanup dos Maps ───────────────────────────────────
//
// Complementa o Teste 1 verificando que o Map de mutexes NÃO cresce
// indefinidamente — i.e., entradas são removidas após o uso.
// Requer que o store exponha o tamanho interno; caso contrário mede heap delta
// com um volume maior para tornar o leak visível.

async function benchMapCleanup() {
	console.log('\n── Teste 1b: validação de cleanup dos Maps (stress) ──────────')

	const store = makeStore()
	const ROUNDS = 3
	const KEYS_PER_ROUND = 1000

	await forceGC()
	const snapshots: number[] = []

	for (let r = 0; r < ROUNDS; r++) {
		const keys = Array.from({ length: KEYS_PER_ROUND }, (_, i) => `jid-r${r}-${i}@s.whatsapp.net`)

		for (const key of keys) {
			await store.transaction(async () => {
				await store.set({ session: { [key]: new Uint8Array(8) } })
			}, key)
		}

		await forceGC()
		snapshots.push(heapMB())
		console.log(`  round ${r + 1}/${ROUNDS} (${KEYS_PER_ROUND} keys): heap=${snapshots[r].toFixed(2)} MB`)
	}

	// Se o heap cresce monotonicamente entre rounds, há leak.
	const isMonotonic = snapshots.every((v, i) => i === 0 || v > snapshots[i - 1] + 1)
	const status = isMonotonic ? '❌ FAIL (heap cresce a cada round — leak detectado)' : '✅ PASS (heap estável entre rounds)'
	console.log(`  resultado: ${status}`)
}

// ─── teste 2: heap sob carga concorrente ──────────────────────────────────────

async function benchConcurrentLoad() {
	console.log('\n── Teste 2: heap sob carga concorrente ────────────────────────')

	const store = makeStore()
	const ROUNDS = 5
	const CONCURRENT = 50

	const samples: number[] = []

	for (let round = 0; round < ROUNDS; round++) {
		await forceGC()
		const before = heapMB()

		await Promise.all(
			Array.from({ length: CONCURRENT }, (_, i) =>
				store.transaction(async () => {
					await store.set({ session: { [`key-${i}`]: new Uint8Array(32) } })
					await store.get('session', [`key-${i}`])
				})
			)
		)

		await forceGC()
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

// ─── teste 3a: throughput sequencial ──────────────────────────────────────────
//
// Mede ops/sec em execução estritamente serial.
// Este teste FAVORECE implementações sem mutex (ex: Arquivo 4).
// Use para comparar overhead de mutex no pior caso para o Arquivo 3.

async function benchThroughputSequential() {
	console.log('\n── Teste 3a: throughput sequencial ───────────────────────────')

	const store = makeStore()
	const OPS = 1000

	// warm-up adequado para o V8 JIT compilar os hot paths
	for (let i = 0; i < 100; i++) {
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
	console.log(`  [nota] teste serial — favorece implementações sem mutex`)
}

// ─── teste 3b: throughput concorrente ─────────────────────────────────────────
//
// Mede ops/sec com N transações disparadas simultaneamente via Promise.all.
// Este é o cenário REAL de produção com múltiplas sessões.
// Aqui o mutex do Arquivo 3 se justifica — protege de race conditions.

async function benchThroughputConcurrent() {
	console.log('\n── Teste 3b: throughput concorrente (cenário real) ────────────')

	const store = makeStore()
	const OPS = 1000

	// warm-up
	await Promise.all(
		Array.from({ length: 50 }, (_, i) =>
			store.transaction(async () => {
				await store.set({ session: { [`warmup-${i}`]: new Uint8Array(4) } })
			})
		)
	)

	const start = performance.now()

	await Promise.all(
		Array.from({ length: OPS }, (_, i) =>
			store.transaction(async () => {
				await store.set({ session: { [`k${i}`]: new Uint8Array(4) } })
				await store.get('session', [`k${i}`])
			})
		)
	)

	const elapsed = performance.now() - start
	const opsPerSec = (OPS / elapsed) * 1000

	console.log(`  ${OPS} transações concorrentes em ${elapsed.toFixed(1)} ms`)
	console.log(`  throughput: ${opsPerSec.toFixed(0)} ops/sec`)
	console.log(`  [nota] teste concorrente — cenário real multi-sessão`)
}

// ─── teste 3c: throughput com keys nomeadas (paralelo por chave) ──────────────
//
// Exclusivo do Arquivo 3: transações com keys distintas devem rodar em
// paralelo, enquanto transações com a mesma key são serializadas.
// Valida o ganho de throughput do sistema de txMutexes por chave.

async function benchThroughputNamedKeys() {
	console.log('\n── Teste 3c: throughput com keys nomeadas (paralelo por chave) ')

	const store = makeStore()
	const SESSIONS = 20
	const OPS_PER_SESSION = 50
	const OPS = SESSIONS * OPS_PER_SESSION

	// warm-up
	for (let i = 0; i < 50; i++) {
		await store.transaction(async () => {
			await store.set({ session: { warmup: new Uint8Array(4) } })
		})
	}

	const start = performance.now()

	// Cada "sessão" tem sua própria chave → devem rodar em paralelo
	await Promise.all(
		Array.from({ length: SESSIONS }, (_, s) =>
			(async () => {
				const sessionKey = `session-${s}@s.whatsapp.net`
				for (let i = 0; i < OPS_PER_SESSION; i++) {
					await store.transaction(async () => {
						await store.set({ session: { [`k${s}-${i}`]: new Uint8Array(4) } })
						await store.get('session', [`k${s}-${i}`])
					}, sessionKey)
				}
			})()
		)
	)

	const elapsed = performance.now() - start
	const opsPerSec = (OPS / elapsed) * 1000

	console.log(`  ${SESSIONS} sessões × ${OPS_PER_SESSION} ops = ${OPS} total em ${elapsed.toFixed(1)} ms`)
	console.log(`  throughput: ${opsPerSec.toFixed(0)} ops/sec`)
	console.log(`  [nota] keys distintas devem rodar em paralelo — se throughput`)
	console.log(`         for similar ao sequencial, o paralelismo não está ocorrendo`)
}

// ─── teste 4: leituras diretas (fora de transação) ────────────────────────────
//
// Nota: o setup (store.set) também passa pelo mutex no Arquivo 3,
// então o baseline já inclui esse overhead. Para isolar apenas as leituras,
// pré-populamos via state mock diretamente se possível, ou aceitamos
// que o setup está no mesmo plano de comparação.

async function benchDirectReads() {
	console.log('\n── Teste 4: leituras diretas (sem transação) ──────────────────')

	const store = makeStore()

	// popula o store dentro de uma transação para minimizar overhead do setup
	await store.transaction(async () => {
		await store.set({
			session: Object.fromEntries(
				Array.from({ length: 200 }, (_, i) => [`k${i}`, new Uint8Array(8)])
			)
		})
	})

	// warm-up
	for (let i = 0; i < 50; i++) {
		await store.get('session', [`k${i % 200}`])
	}

	const OPS = 2000
	const start = performance.now()

	for (let i = 0; i < OPS; i++) {
		await store.get('session', [`k${i % 200}`])
	}

	const elapsed = performance.now() - start
	console.log(`  ${OPS} leituras diretas em ${elapsed.toFixed(1)} ms (${((OPS / elapsed) * 1000).toFixed(0)} ops/sec)`)
}

// ─── teste 5: corretude sob concorrência ──────────────────────────────────────
//
// Verifica que transações concorrentes NÃO corrompem o estado.
// Uma implementação sem mutex (Arquivo 4) pode falhar aqui se
// duas transações lerem/escreverem o mesmo dado simultaneamente.

async function benchCorrectness() {
	console.log('\n── Teste 5: corretude sob concorrência ────────────────────────')

	const store = makeStore()
	const CONCURRENT = 100
	let errors = 0

	// Cada transação escreve um valor único e lê de volta — deve bater
	const results = await Promise.allSettled(
		Array.from({ length: CONCURRENT }, async (_, i) => {
			const key = `correctness-${i}`
			const value = new Uint8Array([i % 256])

			await store.transaction(async () => {
				await store.set({ session: { [key]: value } })
				const read = await store.get('session', [key])

				// dentro da transação, o valor lido deve ser o que foi escrito
				const readValue = read[key] as Uint8Array | undefined
				if (!readValue || readValue[0] !== value[0]) {
					errors++
					throw new Error(`corrupção detectada em key=${key}: esperado=${value[0]}, recebido=${readValue?.[0]}`)
				}
			})
		})
	)

	const failed = results.filter(r => r.status === 'rejected').length
	console.log(`  ${CONCURRENT} transações concorrentes: ${CONCURRENT - failed} OK, ${failed} falhas, ${errors} corrupções`)

	const status = errors === 0 && failed === 0 ? '✅ PASS (sem corrupção)' : '❌ FAIL (corrupção detectada)'
	console.log(`  resultado: ${status}`)
}

// ─── runner ───────────────────────────────────────────────────────────────────

async function main() {
	console.log('=== Benchmark: addTransactionCapability ===')
	console.log(`Node ${process.version} | ${new Date().toISOString()}`)

	await forceGC()
	const baselineHeap = heapMB()
	console.log(`\nheap baseline: ${baselineHeap.toFixed(2)} MB`)

	await benchMapGrowth()
	await forceGC()

	await benchMapCleanup()
	await forceGC()

	await benchConcurrentLoad()
	await forceGC()

	await benchThroughputSequential()
	await forceGC()

	await benchThroughputConcurrent()
	await forceGC()

	await benchThroughputNamedKeys()
	await forceGC()

	await benchDirectReads()
	await forceGC()

	await benchCorrectness()

	await forceGC()
	const finalHeap = heapMB()
	console.log(`\n── heap final: ${finalHeap.toFixed(2)} MB (baseline era ${baselineHeap.toFixed(2)} MB)`)
	console.log('=== fim ===')
}

main().catch(e => {
	console.error(e)
	process.exit(1)
})