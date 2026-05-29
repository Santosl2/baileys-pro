# Baileys Fake WhatsApp Server (E2E test harness)

A self-contained WebSocket server that speaks the WhatsApp **Noise XX** handshake and binary-XML protocol well enough for real `baileys` clients to connect, complete the handshake, and reach `connection: 'open'`. Built to drive **concurrency / race-condition / load tests** against the library without touching the public WhatsApp servers.

> ⚠️ This is a **test fixture**, not a WhatsApp re-implementation. See the [Limitations](#limitations) section.

---

## Layout

```
test-server/
├── src/
│   ├── server.ts            # FakeWAServer (ws + handshake + scenario engine)
│   ├── server-noise.ts      # server-side Noise XX handshake
│   ├── test-cert.ts         # runtime cert chain + WA_CERT_DETAILS patch
│   ├── scenarios.ts         # pluggable response scenarios
│   ├── fault-injector.ts    # deterministic latency / drop / dup / disconnect
│   ├── client-harness.ts    # spawn N pre-seeded baileys clients
│   ├── metrics.ts           # counters, latency histogram, event log
│   ├── logger.ts            # pino wrapper
│   └── index.ts             # public surface
├── tests/
│   ├── server-noise.test.ts # transport-less handshake (no ws, no libsignal)
│   ├── connection.test.ts   # real baileys client reaches open
│   ├── concurrency.test.ts  # swarm of clients exchanging IQs in parallel
│   └── fault-injection.test.ts
├── scripts/
│   └── load.ts              # standalone load harness
├── jest.config.js
├── tsconfig.json
└── package.json             # local scripts; deps inherited from parent
```

## Prerequisites

This package depends on the **parent Baileys workspace**. Make sure the parent's
dependencies are installed first, including the private `libsignal` package
referenced in the root `package.json`:

```bash
# From repository root:
yarn install
```

If `yarn install` fails on the `libsignal` git URL (private token expired), the
fake server's transport-less tests (`server-noise.test.ts`) still pass — but
the full E2E tests that boot a real Baileys client need that dependency.

## Running the tests

```bash
# From repository root:
yarn --cwd test-server test

# Or directly:
cd test-server && npx jest --config jest.config.js
```

Set `FAKE_WA_LOG_LEVEL=trace` to capture every inbound/outbound frame.

## Spawning a fake server in your own test

```ts
import {
  FakeWAServer,
  installTestCerts,
  startFakeClient,
  defaultLoggedInScenario
} from '../test-server/src'

installTestCerts() // mutates WA_CERT_DETAILS in this process

const server = new FakeWAServer({
  scenario: defaultLoggedInScenario(),
  fault: {
    seed: 1234,
    dropProbability: 0.01,
    minLatencyMs: 5,
    maxLatencyMs: 50
  }
})
await server.listen()

const client = await startFakeClient({ url: server.url, user: '5511000000000' })
await client.waitOpen()

console.log(server.metrics.snapshot())

await client.close()
await server.close()
```

## Scenarios

A `Scenario` controls how the fake server replies to inbound frames. The
default `defaultLoggedInScenario()` immediately emits `<success/>` (skipping
the QR pairing flow) and acks every IQ with a generic success result. You can
compose scenarios:

```ts
const myScenario = composeScenarios(
  {
    name: 'echo',
    onNode: (node, ctx) => {
      if (node.tag === 'message') {
        return { tag: 'ack', attrs: { id: node.attrs.id!, to: node.attrs.to! } }
      }
      return null
    }
  },
  defaultLoggedInScenario()
)
```

For the QR-pair code path, use `pairDeviceScenario()`.

## Fault injection

The injector is deterministic — same `seed` + same workload ⇒ exact same fault
sequence. All probabilities are in the `[0, 1]` range.

| Field                          | Effect                                              |
|--------------------------------|-----------------------------------------------------|
| `dropProbability`              | Silently drop the frame                             |
| `duplicateProbability`         | Send the same frame twice                           |
| `reorderProbability`           | Delay the frame so subsequent frames arrive first   |
| `minLatencyMs`/`maxLatencyMs`  | Uniform jitter applied to every delivered frame     |
| `slowProcessingMs`             | Synthetic per-frame processing cost                 |
| `disconnectProbability`        | Forcibly close the WS                               |
| `intermittentErrorProbability` | Reply to inbound IQs with `<iq type="error"/>`      |
| `decider(ctx)`                 | Hard override — returns the exact decision to apply |

The `decider` hook gives you full control for **reproducing a race**:

```ts
new FakeWAServer({
  fault: {
    decider: ctx => {
      if (ctx.node?.tag === 'iq' && ctx.node.attrs.xmlns === 'encrypt') {
        return 'drop'   // always drop pre-key uploads
      }
      return 'allow'
    }
  }
})
```

## Metrics

`server.metrics.snapshot()` returns:

```ts
{
  counters: {
    'connections.opened': 30,
    'handshakes.completed': 30,
    'frames.in': 612,
    'frames.out': 540,
    'frames.dropped': 12,
    // ...
  },
  latency: { count, min, max, mean, p95, p99 },
  events: [ /* last N inbound/outbound events */ ]
}
```

You can also subscribe to live events:

```ts
server.on('connection',  ({ clientId, identity }) => { /* … */ })
server.on('disconnect',  ({ clientId, reason   }) => { /* … */ })
server.on('frame',       ({ clientId, direction, node }) => { /* … */ })
server.on('error',       ({ clientId, error }) => { /* … */ })
```

## Load script

```bash
# 200 clients, 5 % drop, 10–40 ms latency jitter, hold for 10 s
N=200 SEED=42 DROP=0.05 LATENCY_MS=40 DURATION_MS=10000 \
  yarn --cwd test-server load
```

## Determinism for race-condition reproduction

1. Pin the PRNG via `fault.seed`.
2. Pin the client identities (`user` / `device`) and the spawn order.
3. Use a `decider` to force the exact decision tree you want for each frame.
4. Capture `server.metrics.snapshot().events` for post-mortem comparison.

With those three knobs the test outcome is byte-for-byte reproducible.

---

## Limitations

These are inherent constraints — the fake server is **not** trying to fully
emulate WhatsApp:

1. **Cert chain root key.** WhatsApp signs its noise certificates with a
   private key we do not have. `installTestCerts()` patches the shared
   `WA_CERT_DETAILS` constant in `src/Defaults/index.ts` so clients in the
   same Node process accept our test root. Production code paths must not be
   running in the same process unless `uninstallTestCerts()` is called first.
2. **No `wss://` routing header.** Clients with `creds.routingInfo` set will
   be rejected at the handshake. Always start tests with a fresh
   `initAuthCreds()` (the harness does this for you).
3. **Identity / Signal protocol semantics are not implemented.** The fake
   server accepts whatever client static key is presented and synthesises a
   `lid`. Tests that rely on signal session validity must mock those flows
   themselves.
4. **Subset of IQ handlers.** The default scenario returns `<iq type="result"/>`
   for every unknown IQ to keep clients alive. Add explicit handlers in your
   own scenario if you need richer semantics (group metadata, app-state sync,
   media tokens, etc.).
5. **Pairing flow.** `pairDeviceScenario()` only emits `<pair-device>` refs;
   it does not complete pairing because that would require generating a valid
   ADV signed device identity.
6. **Keep-alive.** Clients send `iq xmlns="w:p"` pings; the default scenario
   acknowledges them generically, but the server does not currently send
   server-initiated keep-alives.
7. **`syncFullHistory` / `fireInitQueries`.** The harness forces both to
   `false` because the fake server does not implement those query bundles.
8. **Process-wide cert patch.** Because `WA_CERT_DETAILS` is shared, you
   cannot mix patched test clients and unpatched production clients in the
   same Node process. Use child processes if you need both.

If your test scenario hits a limitation, prefer extending `scenarios.ts`
rather than monkey-patching internal Baileys modules — that keeps the
contract local and inspectable.
