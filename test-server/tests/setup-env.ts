// Loaded by Jest before any test modules. Disables the New Relic agent that
// is transitively required by libsignal so it does not attempt to bootstrap
// (and spam stderr) during the test run.
process.env.NEW_RELIC_ENABLED = 'false'
process.env.NEW_RELIC_AGENT_ENABLED = 'false'
process.env.NEW_RELIC_NO_CONFIG_FILE = 'true'
process.env.NEW_RELIC_LOG = 'stdout'
process.env.NEW_RELIC_LOG_LEVEL = 'fatal'
