# Known traps and rejected patterns

This catalog distinguishes intentional architecture from patterns that exist in
the repository but should not be copied. Each trap includes the failure mode;
rules without reasons are easy for an agent to “simplify” away.

## Treating existing code as precedent

**Trap:** finding one implementation and extending its shape.

The working tree contains several generations of design and incomplete rewrite
work. Existence proves only that code was written. Corroborate with product
constraints, newer repeated patterns, invariants, and actual verification.

## Executor workers inherit Node CLI flags

**Trap:** spawning `worker_threads` with the default `process.execArgv`, or
pointing a development worker at a `.ts` file and assuming parent `--import tsx`
applies.

`node --test` turns the worker into a test runner so Actions never complete.
`--watch` watches the worker entry forever. Worker threads also do not reliably
apply the parent TypeScript loader, which surfaces as `ERR_UNKNOWN_FILE_EXTENSION`
and a hung Action. Filter test/watch flags and boot development workers through
`executorWorker.dev.mjs`.

## Scattered `.test.ts` files

**Trap:** adding a test beside every helper and reporting it as passed.

The executable surface is `scripts/tests/unit/<module>/` and
`scripts/tests/smoke/`, run by `npm run test:unit` and `npm run test:smoke`.
A co-located `*.test.ts` next to domain source is not executed by those
commands and creates false confidence. Add tests to the organized runner.

## Modern-browser cargo cult

**Trap:** importing PDF.js, persisting Blob, using new IDB/stream APIs, modern
CSS, or a library's default target because it is standard in current browsers.

Chrome 70–80 is production. The correct solution may render on the server,
persist ArrayBuffer extents, inject compatibility CSS, or rebuild WebAssembly
for MVP features. Prove in the pinned browser.

## Micro-optimization against the wrong scale

**Trap:** splitting the client bundle for first paint, adding a distributed
database/cache/broker, or abstracting multiple readers because public SaaS
guides recommend it.

ClassApp's constraints favor one atomically installed bundle and one SQLite
writer. Added distributed ownership is a net loss until a measured premise
changes.

## Layer-name reasoning

**Trap:** “it is in a Service, therefore business logic belongs here.”

Services own objective mechanisms. Actor authorization belongs in Facades; SQL
belongs in Data; process lifecycle belongs in Runtime; network/IDB choice belongs
in interact. Decide by responsibility and lifetime, not filename.

Current examples to improve rather than copy include Incident key SQL in
`IncidentService`, global/singleton update-manager access, and schema creation in
individual Data modules.

## Generic capability DSL or `isAdmin` bypass

**Trap:** hiding product rules behind a generic permission array, or passing
`isAdmin/force` into Services.

The former invents a second policy language; the latter scatters authorization
into objective mechanisms. State legitimate paths in the Facade and keep
Services domain-valid.

## Feature bitset on the wire

**Trap:** exposing database bit positions as API/product semantics.

Bitsets are SQLite compression. Clients receive semantic booleans. Coupling wire
to bit layout made the historical role/feature migration fragile.

## Mutable labels as identity

**Trap:** keying or uniqueness-constraining cached entities by handle/username,
or embedding them into immutable history.

A stale cached row can permanently block a new server identity reusing the
handle. Profile changes can also trigger false immutable-content violations.
Use stable IDs and normalized presentation entities. Domain APIs/events carry
deduplicated public user metadata beside entities in a `users` side bundle;
they do not embed mutable labels in each entity.

## Broad immutable deep equality

**Trap:** storing an aggregate API object as immutable and deep-comparing it.

Aggregate DTOs mix Article core, author presentation, bookmark/progress, and
list membership. One username/title/state change can poison all future cache
writes. Define the immutable projection field-by-field.

## Rows imply coverage

**Trap:** assuming min/max/count proves a continuous list, or expanding coverage
with an isolated event/page.

Server sequence may have gaps in a conversation, pages may be partial, and
events may skip history. Coverage expands only from an authoritative connected
cursor response.

## Advancing watermarks after skipped writes

**Trap:** ignoring rows outside the current cache window but still advancing
`known_revision`.

The client will never ask for those revisions again. A watermark is a certificate
and moves only after represented data was stored or explicitly proven irrelevant
under the protocol.

## Empty-but-newest coverage

**Trap:** trim all Posts but leave `reached_newest=true` with null endpoints.

Live append logic may require an upper row, drop the new Post, then advance the
revision. Delete coverage entirely when no covered rows remain.

## Snapshot-then-mutate across transactions

**Trap:** read keys/policy/coverage, perform several transactions, and delete or
overwrite based on the old snapshot.

Concurrent event/upsert/retention extension creates orphan or inaccessible
state. Use one transaction where bounded, otherwise generation/tombstone/CAS
and revalidate at mutation.

## Mutable global actor context

**Trap:** calling `activeMe()` or session getter repeatedly inside a long async
operation.

An actor switch can split one batch between namespaces. Capture `(userId,
authEpoch)` once and pass it explicitly. A Proxy convenience is not permission
to hide context in multi-step work.

## Cache on the online critical path

**Trap:** `remote success → cache write → cache read → return`, or reading broken
cache before allowing a remote request.

Logical cache corruption becomes an online outage. Report/repair cache failure
but return a safe valid remote read. Do not advance local proofs. Pending user
decision writes remain durability-critical.

## Catch-all offline fallback

**Trap:** any exception returns stale/empty local data.

Contract violations, IDB corruption, programming errors, and actor mismatches
are not offline. Catch only transport unavailability for an offline branch;
propagate/report other failures.

## Cleanup replaces primary failure

**Trap:** `finally`/catch throws unlink/close error and loses render/deploy/DB
error.

Preserve primary stack and attach cleanup errors as suppressed diagnostics. Put
acquisition inside the protected scope so synchronous setup failure releases
earlier resources.

## Events before commit

**Trap:** Service writes locally and immediately publishes, then an outer
cross-Service transaction rolls back.

Clients observe state that never committed. Register observable side effects
with request `UnitOfWork.afterCommit`.

## Client `Promise.all` as bulk transaction

**Trap:** UI maps selected admin rows to individual Actions.

This creates partial success, inconsistent audit, uncontrolled concurrency, and
hard retry semantics. Define one semantic bulk Action and server transaction or
an explicit partial-result workflow.

## Network inside transaction

**Trap:** hold SQLite/IDB transaction while rendering, fetching, calling an AI
provider, waiting for timer, or decompressing.

Transactions lock resources and may auto-close. Use reserve/stage/external-work/
publish state machines.

## Multiple update owners

**Trap:** launcher and server each start rollback timers, Service Worker discovers
independent updates, or rows carry redundant active flags.

Competing owners disagree after restart or partial activation. Launcher owns
rollback; BundleManager owns discovery; pointers own activation.

## Compatibility shim by default

**Trap:** keep old fields/readers/writers and add a new path.

Dual truth makes every future change harder. For reconstructible IDB data, yanked
hard rebuild is usually safer. For server data, write an ordered migration and
remove old code. A shim requires a supported source, test, owner, and removal
condition.

## Giant-file accretion

**Trap:** append unrelated functions to `repository.ts`, `server/data/ai.ts`, a
large hook, or admin tab because related code is already there.

Large files obscure ownership and transaction boundaries. Extract coherent
mechanisms with narrow APIs; do not split raw helpers so widely that atomic
operations become impossible.

## UI duplicates domain policy

**Trap:** component checks roles/membership/network and decides a mutation is
allowed, or merges timestamp/revision state.

UI checks are presentation only. Facade and interact/data are authoritative.

## Materialized means loop ended

**Trap:** mark an Article/document saved after a fetch loop breaks.

Early null, wrong `has_more`, missing dependency, or decode failure can end the
loop. Prove expected byte/segment/item coverage and hashes before publication.

## Update hash equals authenticity

**Trap:** treating manifest-provided SHA-256 as publisher authentication.

It detects mismatch with the same manifest, not a malicious manifest. Deployment
provenance needs trusted transport/pinning/signature policy. Do not claim more
security than implemented.
