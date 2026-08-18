# Binary storage, retention, and quota

This document covers browser-side binary materialization. The server-side
object store and eviction ledger are documented separately in
[server blob storage and quota](../systems/server-storage.md).

Chrome 70–80 IndexedDB behavior dictates the storage mechanism. Persist binary
data as `ArrayBuffer`, never `Blob`. A temporary in-memory Blob is permitted
only as an adapter for browser APIs such as object URLs.

## Extent format

```text
extent size  = 4 MiB
key          = (physical generation ID, zero-based extent number)
value        = ArrayBuffer only
```

Invariants:

1. extents are contiguous from zero;
2. every non-final extent is exactly 4 MiB;
3. only the final extent may be shorter;
4. zero-length file has a complete head and no extent;
5. an extent stores no repeated metadata;
6. readers resolve a logical ID through one published complete generation.

Metadata repeated in every extent increases LevelDB writes and memory. Store
size, state, timestamps, checksum, and logical mapping in the file head.

## Low-level operations

`grow`, `shrink`, `read`, `write`, and `delete` operate on logical files but use
generation-aware heads. `write` does not implicitly grow. Large changes are
bounded batches; a mutation journal records target size/state so restart can
finish idempotently.

Use an exclusive lock per logical file for mutation and a shared lock for read
or stream. Do not use one global binary-store lock.

## Atomic publication

Whole-resource download/replacement:

```text
allocate staging generation
  → sequentially fetch/decode/write bounded extents
  → validate expected coverage, sizes, and hashes
  → atomic file-head publication
  → mark previous generation retired
  → bounded orphan/retired GC
```

Never overwrite the active generation in place. A reader must see the old
complete file or the new complete file, never half of either.

Document bundle resources remain stored in their archive encoding (identity or
zstd) and are decompressed on use. Content IDs verify raw data after decode.

## Retention claim versus materialization

User intent and physical availability are separate:

```ts
type Claim =
  | { kind: "conversation-window"; keep_after_ms: number }
  | { kind: "article"; protected_until: number }
  | { kind: "media"; protected_until: number };

type Materialization = {
  complete: boolean;
  bytes: number;
  last_touched_at: number;
  missing_reason: null | "never-downloaded" | "evicted" | "failed";
};
```

An Article is materialized only after metadata plus all text segments or all
required document resources have been validated. Early EOF, missing content,
or a lying `has_more=false` must leave it incomplete.

Media audio is materialized as extent file `media:<track_id>:audio`. Its
complete generation is published only after the server-reported byte size and
SHA-256 have been verified; a `media` claim records local retention intent
independently of the server-side track ref count.

Conversation retention is a moving window. Trimming may remove only a legal
covered prefix or the whole window; never punch a hole in the middle.

Claims are keyed by claimant (normally stable user ID). One account must not
silently overwrite another's device retention choice. A true device-wide policy
uses an explicit `device` claimant.

## Quota algorithm

`navigator.storage.estimate()` is an origin-level estimate, so the application
also keeps logical byte accounting. Begin cleanup at at least 90% usage and aim
for at most 80%.

Eviction order:

1. unclaimed/expired least-recently-used complete bodies and old Post prefixes;
2. lower-priority materializations;
3. protected resources only when necessary to restore operation.

Never automatically evict:

- pending user proposals;
- small actor/decision canonical state;
- app initialization markers;
- active Shell/bundle;
- any bundle generation not explicitly retired by its lifecycle owner.

If protected content is forced out, retain its claim and mark it `evicted`; the
UI can tell the truth and rematerialize later.

Cleaner requirements:

- bounded batches and memory;
- cancellation/actor context;
- no-progress guard;
- termination when no candidates exist;
- recheck candidate protection in the deletion transaction;
- one bounded emergency cleanup retry after `QuotaExceededError`;
- Incident reporting for invariant failure, not for ordinary lack of candidates.

## Race analysis

Never delete from a stale row snapshot while separately reading current
coverage. A concurrent live Post or newly extended retention claim can be lost.
Candidate selection may happen outside the transaction, but deletion must
compare a generation/version and revalidate all protection and boundaries in the
write transaction.

Multi-transaction purge requires a durable tombstone/generation. Otherwise a
concurrent upsert between “snapshot keys” and “delete keys” creates orphan or
inaccessible state.

## Verification

- property sequences of grow/shrink/read/write/delete;
- interruption after every batch;
- concurrent shared read and exclusive publication;
- orphan staging recovery;
- hash/size mismatch rejection;
- trim/live-event races;
- quota no-progress termination;
- forced protected eviction preserves claim;
- complete materialization cannot be published with a missing segment/resource;
- Chrome 70 ArrayBuffer/key round trips and Web Lock fallback behavior.
