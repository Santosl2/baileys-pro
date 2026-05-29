/** @type {import('jest').Config} */
module.exports = {
	rootDir: __dirname,
	roots: ['<rootDir>/tests'],
	testMatch: ['**/*.test.ts'],
	transform: {
		'^.+\\.(ts|tsx)$': ['ts-jest', {
			tsconfig: '<rootDir>/tsconfig.json',
			// Skip type-checking: the parent project has pre-existing strict-null
			// issues that are unrelated to this fixture. Runtime behaviour is what
			// these tests validate.
			isolatedModules: true,
			diagnostics: false
		}]
	},
	moduleNameMapper: {
		'^baileys-internal/(.*)$': '<rootDir>/../src/$1',
		// Parent's src/Utils/crypto.ts does `require('libsignal')`. The package
		// is only installed in test-server/node_modules, so funnel any reference
		// (from any directory) to that copy.
		'^libsignal$': '<rootDir>/node_modules/libsignal',
		'^libsignal/(.*)$': '<rootDir>/node_modules/libsignal/$1',
		// Mock out the New Relic agent entirely — libsignal pulls it in eagerly
		// and it does not tolerate the test sandbox.
		'^newrelic$': '<rootDir>/tests/newrelic-stub.js'
	},
	testEnvironment: 'node',
	setupFiles: ['<rootDir>/tests/setup-env.ts'],
	// Keep the test runtime modest; individual tests may override.
	testTimeout: 60_000
}
