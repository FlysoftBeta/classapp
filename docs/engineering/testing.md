# Testing and verification

Tests are executable evidence for invariants, not a reflexive `.test.ts` beside
every changed file.

## Current test reality

The owned executable surface lives under `scripts/tests/` and is wired to
package scripts:

| Layer | Command | What it proves |
| ----- | ------- | -------------- |
| Unit / in-process mechanism | `npm run test:unit` | Pure `client/repo` merge/coverage/quota/time/authority logic and isolated SQLite mechanisms |
| Smoke | `npm run test:smoke` | Each server subsystem answers real Actions over WebSocket on a fresh database |
| Seeded smoke | `npm run test:smoke:seeded` | The same Action paths against a copied seed/production database after a forced root-PIN reset |
| Chrome 70 E2E | `npm run test:e2e` | Production Shell, HTTPS, install, offline boot, reconnect |
| Manual | `npm run test:manual` | A human can inspect the packaged runtime |

`npm test` runs unit then fresh-database smoke. `npm run lint` still does not
execute tests.

Do not scatter `.test.ts` files through `client/`, `server/`, or `shared/`.
Add cases to the classified trees:

```text
scripts/tests/unit/{client,server,shared}/   Node test runner, no live server
scripts/tests/smoke/suites/                  one suite per Action subsystem
scripts/tests/smoke/harness.ts               isolated data root, PIN reset, protocol client
```

Unit tests may use injected clocks and in-memory SQLite. They must not start
Coordinator, bind ports, or talk to a browser. Smoke tests start the real
development backend, connect to `/ws`, login, and check returned state. They
do not go through the React client, IndexedDB, or Vite.

The smoke harness sets `CLASSAPP_EXECUTORS=1` so a single worker handles
Actions. Development workers load TypeScript through `executorWorker.mjs`
(`tsx/esm/api`) because Node cannot use a `.ts` Worker entry point. Executor
workers must not inherit the parent `--test` flags; see
`executorWorkerExecArgv`.

Smoke isolation:

- data roots are temporary directories, never `worktree/data` in place;
- seeded mode copies `CLASSAPP_SMOKE_SEED_ROOT/data.db` (default
  `worktree/data/data.db`) with SQLite backup, then replaces the root
  administrator PIN with a harness-owned value;
- `CLASSAPP_SMOKE_DATA=fresh|seeded|all` selects which database story runs.

A temporary investigation still belongs under `.cache/` or a one-off probe and
must be deleted unless it is moved into this surface. See
[repository infrastructure](./repository-infrastructure.md) for script layout.

This is not an argument against tests. It is an argument against non-executed
test-shaped files that mislead agents and reviewers.

## Verification pyramid for this project

### Pure invariant/property tests

Best for merge algebras in `client/repo`, cursor comparison, feature encoding, pricing, archive
parsing, text segmentation, and state machines. Generate reorderings,
duplicates, boundary values, and interrupted sequences.

### Mechanism integration tests

Use real SQLite/IndexedDB/filesystem behavior for:

- migration and constraints;
- UnitOfWork rollback/post-commit;
- WAL snapshot / write-lock re-read;
- IDB schema owner race and transaction abort;
- extent publication and orphan GC;
- blob staging/trash mtime GC versus create, drop, and touch;
- quota reconcile versus rematerialize/touch;
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
npm run test:smoke          # fresh isolated database
npm run test:smoke:seeded   # copied seed/production database, root PIN reset
npm run build -- <target>
npm run test:e2e            # when production browser path is affected
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
