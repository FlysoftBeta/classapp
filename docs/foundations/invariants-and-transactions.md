# Invariants, transactions, and publication

Correctness begins with predicates over state, not with classes or endpoints.
For a change, write the invariant before writing the implementation.

## Invariant forms

Useful forms include:

### Identity

```text
identity(entity) is immutable
mutable labels such as handle or username are never foreign identity
```

Examples: Post UUID, Article UUID, `conv_id`, content ID, build ID. A mutable
handle may be indexed for lookup but must not be embedded as the identity of
cached history.

### Order

```text
sequence(new) > sequence(previous)
cursor = (sort_value, stable_id)
```

The stable tie-breaker is mandatory. Global Post sequence can contain numeric
gaps within a conversation; continuity is certified by authoritative paging,
not arithmetic adjacency.

### Monotonic knowledge

```text
published_revision can advance only after every represented row is durable
coverage can expand only across a page connected to a proven boundary
```

A cursor or revision is a certificate. Advancing it without the data it
certifies creates silent, persistent loss.

### Atomic establishment

```text
established(DM) ⇔ DM row and first Post commit together
published(file generation) ⇔ complete extents and file head commit together
successful(admin batch) ⇔ all targets and audit entry commit together
```

### Objective validity

A Service may be called without actor authorization internally, but it may
never construct an invalid domain state. For example, a Post Service can expose
an objective tombstone operation; it still enforces Post identity/revision
rules. The Facade decides whether author deletion or moderator deletion is a
legitimate path.

## Transaction ownership

Single-Service row atomicity may be implemented in Data or the owning Service.
Cross-Service business atomicity belongs at the Facade through the Scope
`UnitOfWork`. Network calls, rendering, archive creation, and AI provider calls
must not execute while SQLite is locked.

The pattern for external work is:

```text
validate and authorize
  → reserve or record durable intent in a short transaction
  → perform external work without a DB transaction
  → validate result
  → publish/settle in a short transaction
  → emit post-commit effects
```

If the process can stop between stages, startup reconciliation must identify
and finish, fail, or release abandoned operations.

## Nested work and `UnitOfWork`

The outermost `UnitOfWork.run` owns commit. Nested calls join that transaction.
Observable effects are registered with `afterCommit` and discarded if any
enclosing layer rolls back.

Rule: a Service operation that may participate in a broader transaction must
not publish WebSocket events, delete external files, or start a process before
commit. It returns enough information for the owning orchestration to schedule
the side effect.

Current code still publishes some events directly after local Data transactions.
Treat that as a correctness gap when composing new multi-Service operations.

## Filesystem publication

SQLite and the filesystem cannot share a transaction. Use generation and
compensation:

1. write to a unique same-filesystem staging path;
2. flush/close if durability matters;
3. validate size, format, hashes, and internal references;
4. atomically rename or update a generation pointer;
5. commit metadata that names the published artifact;
6. retire the previous generation asynchronously;
7. bounded GC removes orphan staging/retired generations.

On failure, preserve the primary error and attach cleanup failure as suppressed
diagnostic evidence. Never replace the original failure with an unlink error.

## IndexedDB transactions

- Acquire a database lease before opening a transaction and release it in an
  outer `finally`, including when `db.transaction()` throws synchronously.
- Queue every IDB request while the transaction is active. Do not await network,
  timers, rendering, decompression, or unrelated Promises inside it.
- Treat only `oncomplete` as commit. An individual request's success is not
  transaction success.
- Notify observers only after completion.
- Multi-batch work needs a journal/generation; “repeat several transactions” is
  not atomic.
- Re-read current state in the mutation transaction. Snapshot-then-delete across
  transactions is a TOCTOU race.

## Events

Events are observable side effects and repair hints. They follow these rules:

1. publish only after the authoritative write commits;
2. carry a complete row or enough identity/revision to refetch safely;
3. never assume delivery, uniqueness, or durable order across reconnect;
4. make repeated application idempotent;
5. refresh subscriptions after membership/authority changes;
6. isolate fan-out listeners so one consumer failure does not suppress others;
7. record contained listener failures as Incidents.

## Deletion semantics

Choose deletion by domain meaning:

- Post deletion is a revisioned tombstone because UUID/sequence remain anchors.
- Actor access removal deletes the actor projection, not the shared objective
  entity.
- User deactivation preserves identity anchors and historical content; purge is
  an explicit cross-Service workflow.
- Cached content may be evicted while the retention claim remains and records
  `evicted`.
- Immutable article deletion removes the server identity and eventually its
  artifacts; the client must not infer deletion from absence on one page.

## Failure-window analysis

For every multi-step operation, enumerate a crash/abort between each pair of
steps. For every window state:

- Is authoritative state valid?
- Can retry safely repeat the operation?
- Can startup/reconnect discover the incomplete state?
- Can old and new readers observe a half-published generation?
- Can a cursor or pointer claim more than is durable?
- Can cleanup race with a concurrent writer?

If the answer depends on “normally these callbacks run in order,” the design is
not complete.
