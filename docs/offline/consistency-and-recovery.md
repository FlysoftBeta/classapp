# Consistency and recovery protocols

Local rows are not evidence of completeness. Each collection protocol defines
identity, authoritative order, coverage proof, merge rule, recovery source, and
watermark publication.

## Transaction scope

Prefer one IndexedDB transaction when several local facts must become visible
together and a partial state would violate a named invariant. Examples include
publishing entity rows with the coverage/revision that certifies them, replacing
an actor snapshot with its access rows, or switching a completed file
generation and its active pointer.

Atomicity is not a reason to create the largest possible transaction. Long
transactions increase abort and old-browser scheduling risk. Do not include
network work, unrelated entities, decompression, or UI state merely for a vague
sense of safety. First enumerate which intermediate states are invalid, then
choose the smallest transaction that prevents them and an explicit recovery
path for the rest.

## Coverage

For an ordered collection, coverage is a rooted continuous interval proven by
authoritative pagination:

```text
C = (lower, upper, reached_oldest, reached_newest, revision)
```

Rows may exist outside `C` as event overlays or isolated pages. They do not
expand `C`. A page expands the interval only when its requested cursor equals a
published boundary and the response connects to that boundary.

Empty-window invariant:

```text
no covered rows ⇒ no published coverage
```

Do not preserve `reached_newest=true` with null boundaries. It creates a state
where live rows can be discarded while revision continues to advance.

## Post protocol

Posts have immutable IDs/sequences and revisioned current state. Conversation
awareness supplies a remote revision and revision sum. Catch-up:

1. capture actor context;
2. read local coverage/revision;
3. obtain the authoritative remote upper revision;
4. page current Post rows in `(known, upper]` using a stable revision keyset;
5. merge by Post ID, rejecting older revisions and flagging equal-revision
   content disagreement;
6. repair/extend the current covered window where justified;
7. only after all pages commit, publish `known_revision = upper`;
8. refresh the conversation snapshot for metadata/access/removals.

Deletion is a tombstone row and therefore participates in the same merge.
Absence from one page never means deletion.

An event outside coverage may be stored as an overlay and trigger catch-up. It
must not assert the missing interval. Event application and quota trimming for
one conversation must be serialized or use transaction-local current state.

## Snapshot protocol

Conversation directory and unrevisioned member lists are authoritative
snapshots for one actor. In one transaction:

- merge objective entities/users;
- replace that actor's relevant access membership;
- merge canonical decision bases without clearing stronger proposals;
- remove actor access absent from the new snapshot;
- leave shared objective entities for other actors intact;
- publish snapshot coverage last in the same transaction.

An event arriving while refresh is underway waits in the recovery queue. Apply
the snapshot first, then replay the event, so an older snapshot cannot erase a
new event.

## Article list protocol

Each `(actor, view, group filter)` owns a rooted range. Cursor identity is:

```text
(server-provided list_sort_at, article_id)
```

The server's sort value is opaque; clients do not recompute it. `before` and
`after` pages extend only their requested boundary. An arbitrary locate page may
cache entities/membership but not claim completeness between it and the root.

List membership is actor/view projection. A missing Article on a partial page
does not delete the objective entity. Explicit delete events or authoritative
snapshot/range reconciliation remove memberships.

## Merge algebras for decisions

### Assignment (LWW)

Used for theme, mute, pin, bookmark, draft, reader settings, and resume
position:

```text
max by timestamp; canonical server base wins exact tie
```

Local timestamps use `max(device_now, previous + 1)` and unique operation IDs.
An Action response can acknowledge only the proposal it sent or an older one;
it cannot clear a newer proposal created while the request was in flight.

Device-clock dominance is an accepted current limitation. If strict causal
ordering becomes necessary, evolve the wire stamp to a logical/physical tuple;
do not silently use incompatible client-only metadata.

### Grow-only watermark

Used for conversation read position and article furthest-read position:

```text
max by domain cursor; timestamp breaks equal-cursor ties
```

Article resume and furthest are separate facts. Resume may move backward and is
assignment. Furthest is monotonic. The command explicitly states `override` or
`furthest`; connection state must not change semantics implicitly.

### Dormant proposal

If access disappears, retain the proposal but exclude it from automatic flush.
If access returns, it may resume. Only an explicit user command may abandon it.
Network errors never erase it.

## Reconnect state machine

```text
disconnected
  → connecting
  → authenticating each binding
  → refreshing access
  → flushing eligible proposals
  → recovering Post revisions
  → refreshing authoritative snapshots
  → replaying queued events in arrival order
  → live
```

Why this order:

- access first prevents writing projections for an actor who no longer qualifies;
- proposals before snapshots allow canonical responses to participate in merge;
- revision catch-up repairs missed objective mutations;
- snapshots repair memberships and metadata;
- event replay last preserves low-latency changes received during recovery.

Recovery is per actor binding even though one physical WebSocket may carry
several actors. Token/credential replacement increments epochs, cancels pending
requests for that binding, and invalidates its event/recovery generations
without disturbing other bindings.

## Concurrency and TOCTOU

Every operation that reads, awaits, then writes must be audited. In particular:

- quota trim re-reads current rows and coverage in the write transaction;
- purge uses a generation/tombstone so concurrent upsert cannot recreate an
  object inside an old deletion plan;
- retention expiry performs compare-and-set, so an old check cannot overwrite
  a newly extended policy;
- response merge compares the captured actor epoch;
- coverage/revision advance occurs with or after the represented writes, never
  from an earlier snapshot;
- in-flight request coalescing keys include actor and semantic query.

## Recovery from logical corruption

Physical IndexedDB validity does not imply logical consistency. Add bounded
invariant checks at startup or affected-use boundaries:

- coverage endpoints name existing rows and agree on ordering;
- empty coverage is absent;
- actor access keys match row actor IDs;
- published file heads name complete generations;
- Article segment intervals are valid and non-conflicting;
- pending markers match actual proposals;
- immutable equal identities do not disagree.

Repair the narrow reconstructible scope when possible; otherwise nuke the
application-owned projection while preserving the independent Shell and any
explicitly protected irreplaceable state. Report an Incident before repair.

Online server truth may be used to rebuild objective entities, access
projections, snapshots, coverage, and other reconstructible materialization.
It is not a blanket fallback for all local state. Drafts, newer pending
proposals, retention choices, and other local-only user intent must be preserved
or explicitly reconciled. A cache write failure must not invalidate an already
valid remote business result, but it must remain observable and schedule repair
where future offline correctness depends on the cache.
