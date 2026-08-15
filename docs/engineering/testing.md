# Testing and verification

Tests are executable evidence for invariants, not a reflexive `.test.ts` beside
every changed file.

## Current test reality

The package scripts run typecheck/ESLint and one production Chrome 70 E2E
harness. There is currently no unit-test runner script. Existing co-located
`.test.ts` files are typechecked but are not executed by `npm run lint` or any
declared `npm test` command.

Therefore:

- do not create another `.test.ts` and claim verification;
- do not scatter test files through domain directories by habit;
- when executable unit/property tests are valuable, first establish one
  intentional runner and organized test surface, then wire it into package/CI;
- until then, put production-path integration harnesses under `scripts/tests`
  and use explicit runnable scripts.

For a temporary investigation, use a directly executed shell/TypeScript probe
or a bounded file below `.cache/`, then remove it. Migration SQL experiments,
Zod shape checks, and one-off state inspections are often useful probes, but
they are not long-term regression evidence until attached to an executable
harness. See [repository infrastructure](./repository-infrastructure.md) for
the current script layout and command meanings.

This is not an argument against tests. It is an argument against non-executed
test-shaped files that mislead agents and reviewers.

## Verification pyramid for this project

### Pure invariant/property tests

Best for merge algebras, cursor comparison, feature encoding, pricing, archive
parsing, text segmentation, and state machines. Generate reorderings,
duplicates, boundary values, and interrupted sequences.

### Mechanism integration tests

Use real SQLite/IndexedDB/filesystem behavior for:

- migration and constraints;
- UnitOfWork rollback/post-commit;
- Facts read-your-writes;
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
