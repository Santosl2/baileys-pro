/**
 * scripts/load.ts — quick load harness. Spawns N clients against the fake
 * server with configurable fault parameters and prints a metrics summary.
 *
 * Usage:
 *   FAKE_WA_LOG_LEVEL=warn N=200 SEED=42 \
 *     yarn --cwd test-server load
 */
import {
	ClientSwarm,
	FakeWAServer,
	installTestCerts,
	makeTestLogger
} from '../src'

const N = parseInt(process.env.N ?? '50', 10)
const SEED = parseInt(process.env.SEED ?? '1', 10)
const DROP = parseFloat(process.env.DROP ?? '0')
const LATENCY = parseInt(process.env.LATENCY_MS ?? '0', 10)
const DURATION_MS = parseInt(process.env.DURATION_MS ?? '5000', 10)

async function main(): Promise<void> {
	installTestCerts()
	const logger = makeTestLogger('load', 'info')

	const server = new FakeWAServer({
		logger,
		fault: {
			seed: SEED,
			dropProbability: DROP,
			minLatencyMs: 0,
			maxLatencyMs: LATENCY
		}
	})
	await server.listen()
	logger.info({ url: server.url }, 'server listening')

	const swarm = new ClientSwarm(server.url, logger)

	const t0 = Date.now()
	await swarm.spawn(N)
	await swarm.waitAllOpen(60_000)
	const handshakeMs = Date.now() - t0
	logger.info({ N, handshakeMs, perClientMs: (handshakeMs / N).toFixed(2) }, 'all clients open')

	await new Promise(res => setTimeout(res, DURATION_MS))

	const snapshot = server.metrics.snapshot()
	logger.info({ snapshot }, 'metrics snapshot')

	await swarm.closeAll()
	await server.close()
}

main().catch(err => {
	// eslint-disable-next-line no-console
	console.error('load run failed:', err)
	process.exit(1)
})
