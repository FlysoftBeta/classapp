# AI-agent change method

This is the required working method for AI agents implementing ClassApp
features. The goal is not merely type-correct code; it is preserving cross-stack
invariants under old-browser, offline, concurrency, restart, and administrative
failure modes.

## 1. Reconstruct the product premise

Before proposing a library or familiar industry pattern, write the relevant
constraints:

- Chrome 70–80 and real API/syntax/CSS support;
- concealed school LAN, intermittent server, managed/shared clients;
- single Node/SQLite deployment and Windows target;
- production Shell/Service Worker/IndexedDB boot path;
- reconstructible local projection versus irreplaceable decisions;
- small community and responsibility-based governance.

Reject solutions whose main argument is “this is standard.” A standard solution
is useful only if it solves the actual constraint.

## 2. Read by flow, not by filename

Trace the complete path before editing:

```text
UI intent
→ interact use case / client API
→ shared Action or raw HTTP contract
→ Action/route
→ Facade authorization and path selection
→ Service invariant
→ Data/infra mutation
→ transaction and event
→ client normalization/merge
→ coverage/proposal/retention
→ presentation and reconnect repair
```

Also trace startup, purge, audit, Incident, and schema consequences. Searching
only for the Service name misses cross-cutting ownership.

Treat current code as evidence, not specification. Compare:

- repeated newer patterns;
- authoritative documentation and relevant Git history;
- historical design rationale available through Git history;
- actual call graph and tests;
- production constraints.

When they conflict, state the conflict. Do not silently preserve the oldest or
most convenient implementation.

## 3. Write the design ledger

For a nontrivial change, capture these before code:

| Question        | Required answer                                                |
| --------------- | -------------------------------------------------------------- |
| Domain meaning  | What user/community outcome exists independent of code?        |
| Isolation       | Snapshot, write-lock re-read, or local variable?               |
| Identity/order  | Stable key, mutable labels, cursor/tie-breaker, revision?      |
| Authority       | Which Facade paths are legitimate and why?                     |
| Owner/lifetime  | Coordinator/Sticky, Executor Scope, operation, local projection, UI? |
| Occupancy       | Protocol, job, or sticky leftover? Which seam if it must ask another occupancy? |
| Transaction     | What must commit atomically? What external work is outside?    |
| Publication     | Pointer/generation/event; what becomes visible when?           |
| Failure windows | Crash, abort, disconnect, actor switch, concurrent writer?     |
| Recovery        | Snapshot, revision, retry/idempotency, startup reconciliation? |
| Offline algebra | Assignment, watermark, server-only, or another explicit merge? |
| Retention/purge | What may be evicted, deactivated, deleted, or rebuilt?         |
| Observability   | Public error, Incident context, audit record?                  |
| Compatibility   | Chrome 70, Windows, existing DB/client schema cutover?         |
| Verification    | Smallest tests that falsify each invariant?                    |

If any cell is unknown, continue investigation. Do not fill gaps with a generic
helper or boolean.

## 4. State invariants mathematically

Prefer predicates that can become assertions/tests:

```text
same ID and revision ⇒ same authoritative content
published revision R ⇒ all relevant rows ≤ R were durably processed
active pointer P ⇒ referenced generation exists and is complete
pending proposal newer than response ⇒ proposal remains pending
actor row key.me_id = captured ActorContext.userId
successful admin batch ⇒ every target changed ∧ one safe audit record exists
```

Then enumerate a failure between each state transition. A diagram is useful
only if it exposes ownership/transition, not as decoration.

## 5. Choose the layer

- transport framing/streaming/multipart/Range → protocol or HTTP adapter;
- wire schema/correlation → shared protocol;
- actor-dependent legitimate path → Facade;
- objective coherent mechanism/invariant → Service;
- SQL/row mapping → Data;
- process/filesystem/native runtime → Runtime/infra, explicitly owned;
  leftover that outlives the request is occupancy, not a request Service
  ([occupancy](../foundations/server-occupancy.md));
- IndexedDB transaction/store mechanism → client/data;
- consistency model (coverage, snapshot, assignment, watermark, immutable, revision) → client/repo;
- local/remote choice, recovery orchestration, quota → client/interact;
- rendering and ephemeral interaction → hooks/components.

Do not create a new layer to avoid understanding the existing one. Do not put
cross-stack policy into a “util.”

## 6. Design migration, not coexistence

The project prefers direct migration:

- update every producer/consumer in one change;
- bump the appropriate protocol/schema/build boundary;
- nuke reconstructible yanked client data when justified;
- write ordered server DB migration for irreplaceable data;
- remove old fields, readers, writers, and shims;
- preserve only explicitly required rollback/upgrade paths.

Compatibility code without a removal boundary becomes a permanent second truth.

## 7. Implement in dependency order

A practical sequence:

1. pure shared/domain types and invariant helpers;
2. database schema/migration and Data primitives;
3. Service objective operations;
4. Facade authority/transaction/audit;
5. Action/event/HTTP contracts and adapters;
6. client repo consistency algebras, then data representation/atomic primitives;
7. interact normalization, recovery, and local/remote choice;
8. hooks/components/admin help;
9. purge/retention/startup/update integration;
10. verification and document update.

Keep temporary compilation breakage local and short. Do not add an `any` or
compatibility overload to keep both models alive.

## 8. Comment decisions, not syntax

At important entry points, add a short English flow comment. Comment surprising
constraints: why an event waits until commit, why a page cannot extend coverage,
why Chrome 70 forbids an API, why a generation is staged. Do not narrate obvious
assignments.

Group small helpers by mechanism and name them in domain terms. A swarm of
top-level generic helpers usually signals missing ownership.

## 9. Verify proportionally

Run typecheck/lint, then targeted invariant tests, then production build. A
browser/storage/Shell/HTTPS change requires the fixed Chrome 70 E2E. A launcher
or packaging change requires target build and lifecycle exercise. A SQL change
requires migration from the oldest supported baseline plus rollback reasoning.

Never claim a co-located `.test.ts` was run merely because it typechecked. The
current package has no unit-test script executing those files.

## 10. Self-review adversarially

Ask:

- Did I add a second owner/cache/pointer?
- Can actor switch split this async operation?
- Can old response/event erase new local intent?
- Can a cursor advance after skipped persistence?
- Does a `catch` hide corruption as offline?
- Does UI perform a bulk transaction with `Promise.all`?
- Can external work hold SQLite or publish before commit?
- Can cleanup replace the original error?
- Can a mutable handle poison identity?
- Did I test the production path rather than only Vite?
- Did I add a modern browser API/library without Chrome 70 proof?
- Did I update purge, audit, incidents, and docs?

## Deliverable standard

A completed change includes code, migration/cutover, verification evidence, and
updated documentation for changed invariants. The handoff names any
remaining known risk precisely. “Tests pass” without saying which tests and
which production constraint they exercise is insufficient.
