# Testing and verification

Tests are executable evidence for invariants, not a reflexive `.test.ts` beside
every changed file.

## Current test reality

The maintained executable test surface lives under `scripts/tests/` and is
wired to package scripts. Node's built-in test runner (`node:test`) executes
it through `scripts/tests/run.mts`.

```text
scripts/tests/
  harness/     isolated temp roots, quota memory DB, thin WebSocket client
  unit/<module>/   pure logic and in-process mechanism tests
  smoke/       HTTP+WebSocket API tests that do not use the application client
  run.mts      test runner
  test-e2e.mts / test-manual*.mts   production browser harnesses
```

Unit tests cover merge algebras, conversation ids, quota heat/eviction,
UnitOfWork, blob GC, pagination, incidents, and other invariants that can be
falsified without a live Coordinator. They use `:memory:` SQLite or temporary
directories and must not import `server/infra/env.ts` unless they first call
`setRuntimeConfig`.

Smoke tests start an isolated development server (`CLASSAPP_EXECUTORS=1`,
temporary `dataRoot`, admin PIN `123456`) and speak the WebSocket protocol
directly. They classify coverage by protocol, auth, groups, posts,
conversations, users (deactivate vs purge), stickers, announcement, and HTTP
discovery. They are not a substitute for Chrome 70 production E2E.

Development executor workers boot through `server/runtime/executorWorker.dev.mjs`,
which loads TypeScript with `tsx/esm/api` `tsImport`. Worker threads do not
reliably apply the parent `--import tsx` hook, and `node --test` flags must
not leak into `execArgv` or the worker becomes a test runner.

Do not scatter co-located `*.test.ts` files through domain directories. A test
that should remain belongs in `scripts/tests/unit/<module>/` or
`scripts/tests/smoke/`, is executed by `npm run test:unit` or
`npm run test:smoke`, and names the invariant it can falsify.

For a temporary investigation, use a directly executed shell/TypeScript probe
or a bounded file below `.cache/`, then remove it. See
[repository infrastructure](./repository-infrastructure.md) for command
meanings.

## Verification pyramid for this project

### Pure invariant/property tests

Best for merge algebras, cursor comparison, feature encoding, pricing, archive
parsing, text segmentation, and state machines. Generate reorderings,
duplicates, boundary values, and interrupted sequences.

### Mechanism integration tests

Use real SQLite/IndexedDB/filesystem behavior for:

- migration and constraints;
- UnitOfWork rollback/post-commit;
- WAL snapshot / write-lock re-read;
- IDB schema owner race and transaction abort;
- extent publication and orphan GC;
- render archive range validation;
- update extraction/part hashes;
- Incident grouping/detail cap/public IDs;
- AI reservation/settlement/restart.

Mocking the mechanism being tested defeats the purpose. Isolate external
providers, clocks, and filesystem roots through injected boundaries.

### Cross-stack contract tests

Validate every Action/event input and output, actor label, incident result, and
normalization path. A server output schema mismatch is a failing implementation,
not something the client should tolerate.

### Fixed Chrome 70 production E2E

Required for any change to:

- client syntax/polyfills/CSS/Web APIs;
- Shell or Service Worker;
- IndexedDB schema/files/transactions;
- HTTPS redirect/certificate entry;
- bundle activation;
- offline boot/reconnect;
- Infini/reader behavior materially relying on browser layout.

The harness builds a real target deployment, launches the packaged launcher,
uses a pinned and SHA-256-verified Chrome 70 package, installs via HTTPS, stops
the server, verifies offline navigation, restarts, and checks recovery. Vite is
not a substitute.

### Platform lifecycle tests

Build and exercise relevant Linux family and Windows packages for launcher,
renderer, native dependency, path, signal, directory swap, and rollback changes.

## Invariant-to-test matrix

Every design ledger invariant gets at least one falsifying test. Examples:

| Invariant                 | Adversarial case                                  |
| ------------------------- | ------------------------------------------------- |
| newer proposal survives   | old response arrives after second local write     |
| revision certifies rows   | cache write fails on last recovery page           |
| snapshot is actor-scoped  | switch actor during reconcile                     |
| coverage has no holes     | isolated event arrives beyond upper bound         |
| generation is complete    | crash after each extent and before pointer commit |
| batch is atomic           | middle target violates constraint                 |
| update timer persists     | restart launcher halfway through timeout          |
| settlement is once        | repeat settlement after simulated lost response   |
| immutable resource agrees | same content ID with different decoded bytes      |
| cache not online-critical | remote result valid, IDB write throws             |

## Clocks and concurrency

Inject or control clocks for LWW, daily/weekly billing, retention, update
watchdogs, session expiry, and Incident timestamps. Test equal timestamps,
far-future device time, timezone/UTC boundaries, and monotonic local increments.

Concurrency tests must control interleaving rather than hope a race occurs:
pause between snapshot and write, inject an event/policy update, then resume.

## Commands and evidence

Minimum common checks:

```sh
npm run lint
npm run test:unit
npm run test:smoke   # when server Actions, protocol, or recycle paths changed
npm run build -- <target>
npm run test:e2e     # when production browser path is affected
```

Report exact commands and outcomes. If a test requires missing secrets/browser
package/platform, state that limitation and run the strongest remaining
non-destructive checks. Do not silently skip.

## Test data safety

- use temporary deployment/data roots, never the user's working database;
- copy production seed only when explicitly configured by the harness;
- clean process groups and temporary directories in `finally`;
- never print secrets;
- verify destructive targets are bounded temporary paths;
- retain useful failure logs/artifacts when cleanup would erase diagnosis.
