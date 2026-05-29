// No-op stub for the New Relic agent. Returned by Jest's moduleNameMapper
// so libsignal's `require('newrelic')` succeeds without bootstrapping the
// real agent (which crashes inside the Jest sandbox).
const noop = () => {}
// Real newrelic signatures:
//   startSegment(name, record, handler [, callback])
//   startWebTransaction(url, handler)
//   startBackgroundTransaction(name [, group], handler)
// Find the first function argument and invoke it (so the wrapped work
// actually runs and its result is propagated). If none of the arguments
// is a function, fall back to a no-op.
const invokeHandler = (...args) => {
	for (const a of args) {
		if (typeof a === 'function') {
			return a()
		}
	}
}
const proxy = new Proxy(function () {}, {
	get(_target, prop) {
		if (prop === 'startSegment' || prop === 'startWebTransaction' || prop === 'startBackgroundTransaction') {
			return invokeHandler
		}
		return noop
	},
	apply() {
		return undefined
	}
})
module.exports = proxy
