/**
 * index.ts — public surface for the test-server.
 */

export { FakeWAServer } from './server'
export type { FakeServerOptions, ConnectionContext, ServerIdentity, ServerEvents } from './server'
export {
	defaultLoggedInScenario,
	pairDeviceScenario,
	composeScenarios,
	replyIqResult,
	replyIqError
} from './scenarios'
export type { Scenario, ScenarioHook, ScenarioReply } from './scenarios'
export { FaultInjector, defaultFaultConfig, sleep } from './fault-injector'
export type { FaultConfig, FaultContext, FaultDecision, FaultDirection } from './fault-injector'
export { Metrics } from './metrics'
export type { CounterName, EventRecord } from './metrics'
export { installTestCerts, uninstallTestCerts } from './test-cert'
export {
	startFakeClient,
	ClientSwarm,
	makePreSeededCreds
} from './client-harness'
export type { FakeClient, FakeClientOptions } from './client-harness'
export { makeTestLogger } from './logger'
export type { TestLogger } from './logger'
