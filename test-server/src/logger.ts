/**
 * logger.ts — small structured logger used by the test server. Wraps `pino`
 * (already a dependency of Baileys) so logs share format with the library.
 */
import pino, { type Logger } from 'pino'

export type TestLogger = Logger

export const makeTestLogger = (
	name = 'fake-wa',
	level: pino.Level = (process.env.FAKE_WA_LOG_LEVEL as pino.Level | undefined) ?? 'warn'
): TestLogger => {
	return pino({
		name,
		level,
		base: undefined,
		timestamp: pino.stdTimeFunctions.isoTime
	})
}
