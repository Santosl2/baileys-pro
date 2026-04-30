/**
 * Benchmark: encode.ts + decode.ts
 *
 * Mede CPU (ops/s, ms/op), memória (heap delta) e pressão de GC (alocações/s).
 *
 * Rodando:
 *   node --expose-gc -r ts-node/register src/Tests/bench.encode-decode.ts
 *
 * Ou via script do package.json:
 *   yarn bench
 */

import { performance } from 'perf_hooks'
import { encodeBinaryNode } from '../WABinary/encode'
import { decodeDecompressedBinaryNode } from '../WABinary/decode'
import * as constants from '../WABinary/constants'
import type { BinaryNode } from '../WABinary/types'

// ─── Helpers ────────────────────────────────────────────────────────────────

declare const gc: (() => void) | undefined

const forceGC = () => {
	if (typeof gc === 'function') {
		gc()
	}
}

const heapMB = () => process.memoryUsage().heapUsed / 1024 / 1024

function runBench(
	label: string,
	fn: () => void,
	iterations: number
): void {
	// Aquece para descartar JIT cold-start
	for (let i = 0; i < Math.min(100, iterations / 10); i++) fn()

	forceGC()
	const memBefore = heapMB()
	const start = performance.now()

	for (let i = 0; i < iterations; i++) fn()

	const elapsed = performance.now() - start
	forceGC()
	const memAfter = heapMB()

	const opsPerSec = (iterations / elapsed) * 1000
	const msPerOp = elapsed / iterations
	const memDelta = memAfter - memBefore
	const allocRateMBs = (memDelta / (elapsed / 1000)).toFixed(2)

	console.log(`\n  ┌─ ${label}`)
	console.log(`  │  Iterações  : ${iterations.toLocaleString()}`)
	console.log(`  │  Tempo total: ${elapsed.toFixed(2)} ms`)
	console.log(`  │  CPU ops/s  : ${Math.round(opsPerSec).toLocaleString()}`)
	console.log(`  │  CPU ms/op  : ${msPerOp.toFixed(4)} ms`)
	console.log(`  │  Heap antes : ${memBefore.toFixed(2)} MB`)
	console.log(`  │  Heap depois: ${memAfter.toFixed(2)} MB`)
	console.log(`  │  ΔHeap      : ${memDelta >= 0 ? '+' : ''}${memDelta.toFixed(2)} MB`)
	console.log(`  └─ Alocação/s : ${allocRateMBs} MB/s`)
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const nodeSimple: BinaryNode = {
	tag: 'message',
	attrs: { id: '3EB0A4B1C2D3E4F5', type: 'text', from: '5511999999999@s.whatsapp.net' },
	content: undefined
}

const nodeBinary: BinaryNode = {
	tag: 'enc',
	attrs: { v: '2', type: 'msg' },
	content: Buffer.alloc(512, 0xab)
}

const nodeNested: BinaryNode = {
	tag: 'handshake',
	attrs: {},
	content: [
		{
			tag: 'clientHello',
			attrs: { ephemeral: 'AAAA' },
			content: Buffer.alloc(32, 0x01)
		},
		{
			tag: 'static',
			attrs: {},
			content: Buffer.alloc(32, 0x02)
		},
		{
			tag: 'payload',
			attrs: { v: '2', type: 'msg', mediatype: 'image' },
			content: 'some-string-payload'
		}
	]
}

const nodeJids: BinaryNode = {
	tag: 'message',
	attrs: {
		from: '5511999999999@s.whatsapp.net',
		to: '5511888888888@s.whatsapp.net',
		participant: '5511777777777@s.whatsapp.net',
		id: '3EB0123456789ABC',
		type: 'text'
	},
	content: undefined
}

const nodeNibble: BinaryNode = {
	tag: 'message',
	attrs: { id: '123456789012345', timestamp: '1700000000' },
	content: undefined
}

const nodeLargeArray: BinaryNode = {
	tag: 'list',
	attrs: { count: '50' },
	content: Array.from({ length: 50 }, (_, i) => ({
		tag: 'item',
		attrs: { id: String(i).padStart(3, '0'), type: 'text' },
		content: `payload-${i}`
	}))
}

// ─── Pre-encode buffers para os testes de decode ────────────────────────────
// encodeBinaryNode prefixed with a 0x00 compression flag byte.
// decodeDecompressedBinaryNode expects the buffer *after* that byte is stripped
// (which is what decompressingIfRequired does). So we slice(1) here.
const encSimple = encodeBinaryNode(nodeSimple).slice(1)
const encBinary = encodeBinaryNode(nodeBinary).slice(1)
const encNested = encodeBinaryNode(nodeNested).slice(1)
const encJids = encodeBinaryNode(nodeJids).slice(1)
const encNibble = encodeBinaryNode(nodeNibble).slice(1)
const encLargeArray = encodeBinaryNode(nodeLargeArray).slice(1)

const DECODE_OPTS = {
	TAGS: constants.TAGS,
	SINGLE_BYTE_TOKENS: constants.SINGLE_BYTE_TOKENS,
	DOUBLE_BYTE_TOKENS: constants.DOUBLE_BYTE_TOKENS
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const ITERS = 100_000
const ITERS_HEAVY = 10_000

function main() {
	console.log('='.repeat(60))
	console.log(' BENCHMARK: WABinary encode.ts + decode.ts')
	console.log('='.repeat(60))

	if (typeof gc !== 'function') {
		console.warn('\n  ⚠  GC manual não disponível. Rode com --expose-gc para métricas de GC precisas.\n')
	}

	// ─── ENCODE ───────────────────────────────────────────────────────

	console.log('\n── ENCODE ──────────────────────────────────────────────────')

	runBench('Nó simples (attrs string, sem conteúdo)', () => {
		encodeBinaryNode(nodeSimple)
	}, ITERS)

	runBench('Nó com conteúdo binário (512 bytes)', () => {
		encodeBinaryNode(nodeBinary)
	}, ITERS)

	runBench('Nó com JIDs (@s.whatsapp.net)', () => {
		encodeBinaryNode(nodeJids)
	}, ITERS)

	runBench('Nó com nibble-packed strings', () => {
		encodeBinaryNode(nodeNibble)
	}, ITERS)

	runBench('Nó aninhado (3 filhos, mixed content)', () => {
		encodeBinaryNode(nodeNested)
	}, ITERS)

	runBench('Array grande (50 filhos)', () => {
		encodeBinaryNode(nodeLargeArray)
	}, ITERS_HEAVY)

	// ─── DECODE ───────────────────────────────────────────────────────

	console.log('\n── DECODE ──────────────────────────────────────────────────')

	runBench('Nó simples (attrs string, sem conteúdo)', () => {
		decodeDecompressedBinaryNode(encSimple, DECODE_OPTS)
	}, ITERS)

	runBench('Nó com conteúdo binário (512 bytes)', () => {
		decodeDecompressedBinaryNode(encBinary, DECODE_OPTS)
	}, ITERS)

	runBench('Nó com JIDs (@s.whatsapp.net)', () => {
		decodeDecompressedBinaryNode(encJids, DECODE_OPTS)
	}, ITERS)

	runBench('Nó com nibble-packed strings', () => {
		decodeDecompressedBinaryNode(encNibble, DECODE_OPTS)
	}, ITERS)

	runBench('Nó aninhado (3 filhos, mixed content)', () => {
		decodeDecompressedBinaryNode(encNested, DECODE_OPTS)
	}, ITERS)

	runBench('Array grande (50 filhos)', () => {
		decodeDecompressedBinaryNode(encLargeArray, DECODE_OPTS)
	}, ITERS_HEAVY)

	// ─── ROUNDTRIP (encode → decode) ──────────────────────────────────

	console.log('\n── ROUNDTRIP (encode → decode) ─────────────────────────────')

	runBench('Nó simples roundtrip', () => {
		const buf = encodeBinaryNode(nodeSimple).slice(1)
		decodeDecompressedBinaryNode(buf, DECODE_OPTS)
	}, ITERS)

	runBench('Nó binário roundtrip', () => {
		const buf = encodeBinaryNode(nodeBinary).slice(1)
		decodeDecompressedBinaryNode(buf, DECODE_OPTS)
	}, ITERS)

	runBench('Array grande roundtrip', () => {
		const buf = encodeBinaryNode(nodeLargeArray).slice(1)
		decodeDecompressedBinaryNode(buf, DECODE_OPTS)
	}, ITERS_HEAVY)

	// ─── MEMORY STRESS ────────────────────────────────────────────────

	console.log('\n── MEMORY STRESS (encode + decode, 1M operações simples) ──')

	const STRESS = 1_000_000
	forceGC()
	const heapStart = heapMB()
	const t0 = performance.now()

	for (let i = 0; i < STRESS; i++) {
		const buf = encodeBinaryNode(nodeSimple).slice(1)
		decodeDecompressedBinaryNode(buf, DECODE_OPTS)
	}

	const elapsed = performance.now() - t0
	forceGC()
	const heapEnd = heapMB()

	console.log(`\n  ┌─ Stress: ${STRESS.toLocaleString()} roundtrips`)
	console.log(`  │  Tempo      : ${(elapsed / 1000).toFixed(2)} s`)
	console.log(`  │  ops/s      : ${Math.round((STRESS / elapsed) * 1000).toLocaleString()}`)
	console.log(`  │  Heap antes : ${heapStart.toFixed(2)} MB`)
	console.log(`  │  Heap depois: ${heapEnd.toFixed(2)} MB`)
	console.log(`  └─ ΔHeap      : ${(heapEnd - heapStart) >= 0 ? '+' : ''}${(heapEnd - heapStart).toFixed(2)} MB`)

	console.log('\n' + '='.repeat(60))
	console.log(' Benchmark concluído.')
	console.log('='.repeat(60) + '\n')
}

main()
