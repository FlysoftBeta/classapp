# Server blob storage and quota

Feature-owned blob directories previously reimplemented path checks, staging,
streaming, and eviction independently. The current mechanism splits that work
into two process Runtime owners under `server/storage/`: a dumb blob bag, and
a heat ledger. Domain code keeps identity, intent rows, and product policy.
Download/render work queues are a third module; they produce files and do not
decide retention.

## Object model

```text
server/storage/
  paths.ts           blob-id validation, sharded layout, tree-path rules
  keyedLock.ts       per-id async mutex owned by one store instance
  gc.ts              staging/trash mtime GC; injectable I/O for TOCTOU tests
  blobStore.ts       allocated-id blobs: create/commit/open/drop, staging/trash GC
  treeStore.ts       manifest ZIP adapter over one blob
  renderArchive.ts   document-specific STORED-ZIP index over one blob
  quotaService.ts    heat ledger; candidate ids only
  storageRuntime.ts  process-bound BlobStore + quota pools + owner evictors
server/data/quota.ts            pool/item SQL and lazy heat ranking
```

A blob is an allocated UUID. Domain tables store that `blob_id`. The on-disk
name is the id, sharded two directory levels from the compact hex form, so
owner keys never appear in filesystem names. The store does not interpret
namespaces or domain keys.

```text
staging/<blob_id>
objects/<aa>/<bb>/<blob_id>
trash/<blob_id>
```

Lifecycle:

1. Domain inserts an intent row (`staging` / `downloading` / `capturing`) naming
   the new `blob_id`.
2. `create()` reserves that id as a staging slot (`wx` for in-store writers;
   an opaque path for trusted local producers such as yt-dlp or pdfrender).
3. `commit(id)` fsyncs and renames into `objects/`. The domain row becomes
   `ready`.
4. `open` / `read` / `stat` use one file descriptor for size and Range, so a
   response cannot mix one file's length with another file's body. `open`
   streams through `FileHandle.createReadStream` so the handle owns the
   descriptor until the body ends; extracting `handle.fd` for
   `fs.createReadStream` lets GC close it, which Node reports as EOF and
   silently truncates Range bodies.
5. Replacement allocates a **new** id. After the domain row points at the new
   id, the owner `drop`s the previous id into `trash/`.
6. Physical deletion is mtime GC of `staging/` and `trash/` only. There is one
   trash name and one retention.

SQLite cannot transact with the filesystem. Compensation is therefore narrow:

- staging files older than the TTL are deleted; owners fail or abandon their
  matching intent rows;
- trash files older than the TTL are deleted;
- the blob store **must not** scan `objects/` minus a live-key snapshot. That
  comparison cannot tell a crash leftover from an in-flight publish.

Trusted local tools (PDF renderer) may receive `materializedPath(id)` as an
opaque input path and must not persist it.

Complex objects remain one ZIP (`manifest.json` plus `objects/<uuid>`
payloads). TreeStore validates, mutates a working copy, and republishes a new
blob. `renderArchive.ts` is not generic storage: it validates the renderer
contract and streams STORED ranges through BlobStore.

## Quota

Quota is an accounting ledger. It does not open, rename, or delete files. It
records how expensive it is to keep an item and how warm that item is, then
emits cache candidate ids when a pool is over its high watermark. The owning
Runtime performs compare-and-delete on domain rows and then `drop`s blobs.

```text
storage_quota_pools(name, max_weight, target_ratio, half_life_ms)
storage_quota_items(pool, item_id, class, weight, heat, touched_at_ms,
                    pin_until_ms, created_at_ms)
```

`item_id` is a domain key (track id, document id, user id), not a `blob_id`.
`class` is `cache` (reconstructible) or `durable` (unique). `weight` is hold
cost, usually bytes. `heat` and `touched_at_ms` fold the whole touch history:

```text
Δt       = max(0, now − touched_at)
heat_now = heat × 0.5^(Δt / half_life)
heat     = heat_now + intensity
touched_at = now
```

A larger `intensity` is a longer stay (for example a playback pulse). Frequent
touches stack because little heat has decayed; a long gap cools the item to
near zero. Ranking decays lazily at query time, so idle rows need no
background write. Cache candidates sort by `weight / (heat_now + ε)` descending.
There is no group min-max normalization.

`max_weight = 0` means the pool is accounted but not auto-evicted by size.
Durable rows never enter the candidate set. If cache eviction cannot free
enough room, new durable writes are refused; unique data is not deleted to
make space. A short `pin_until_ms` after publication keeps a fresh cache item
off the candidate list so a large new download cannot evict itself.

Owner eviction:

1. Quota returns a snapshot `(item_id, weight, heat, touched_at)`.
2. The owner, in one SQLite transaction, rechecks generation, pins/leases, and
   refcount, then deletes or demotes the authoritative row.
3. After commit, `drop` the blobs. A failed drop is staging/trash TTL work.
4. `quota.release` only after the owner succeeded. A concurrent rematerialize
   inserts a new ledger row; a stale snapshot must not delete it.

## Domain wiring

- **Media** — audio and cover are cache; one quota item per track holds combined
  ready weight. `ref_count = 0` means no playlist pin, not “delete now”. Heat
  decides eviction. Metadata remains after assets are dropped.
- **Article bundles** — uploaded PDF source is durable; the render archive is
  cache and a separate item. They must not share one ledger row.
- **Teach documents** — Office copies are cache while they remain reconstructible
  from the source document.
- **AI workspaces** — user-authored trees are durable. Derived materializations
  would be cache if introduced later.
- **Conversations** — may be quota-accounted as durable logical weight without
  moving message bodies into BlobStore. Attachments that are blobs are durable.
- **Post images** — the original is durable (`post-images`, `max_weight = 0`).
  The JPEG thumbnail is cache (`post-image-thumbs`, 512 MB, seven-day
  half-life). Loading a post queues rebuild; eviction returns the thumb row to
  `absent` and drops only the thumb blob. Staging originals older than 30
  minutes and images of tombstoned posts are reclaimed by maintenance. SQLite
  and the filesystem still cannot share a transaction: the staging row is
  inserted before blob commit, and delete tombstones the post before dropping
  blobs.

Maintenance runs BlobStore GC, quota cache sweeps for registered owners, and
each owner's own stale-intent cleanup. It does not walk `objects/`.

## Failure windows

SQLite and the filesystem cannot share a transaction. Unit tests under
`scripts/tests/unit/server/` pin the windows below.

### Blob GC versus create, drop, and mtime touch

Physical deletion is mtime GC of `staging/` and `trash/` only. Each name is
serialized with the blob-id lock, then compared-and-deleted: a second stat
must still see an aged file before unlink. A retry that recreates the same
id, a `utimes` touch that makes the file younger than the TTL, or a later
`drop` into the same trash name after the first snapshot is kept. Missing
names are concurrent commit/discard; other unlink errors surface.
`objects/` must still never be reconciled against a live-key snapshot; a
crash leftover there is indistinguishable from an in-flight publish.

### Quota reconcile versus touch and rematerialize

`QuotaService.reconcile` re-reads the ledger row before calling the owner
evictor, so a touch or rematerialized weight that lands after listing and
before that check is skipped. After the evictor returns, the loop counts a
success only if the ledger row is gone. `release` accepts the snapshot it
was given and compare-and-deletes `(weight, heat, touched_at)`; a stale
owner that releases after a concurrent `account` of the same `item_id`
leaves the rematerialized row. Callers that are not racing an eviction
(abandoning a unique upload id) may omit the snapshot.

### Named tree blobs that are missing on disk

`TreeStore` treats `blobId === null` as an empty tree. A non-null id whose
object is absent is an orphaned pointer and fails; it must not look like a
new workspace.

## Migration

Schema v26 replaces the namespace/key object store and the min-max frequency
ledger. Reconstructible cache from the previous mechanism is dropped rather
than converted: media asset bytes, teaching-document copies, bundle articles
and their upload intents, and the old quota tables. Track metadata, playlists,
and text articles remain. Fresh installs create the v26 tables directly.
Production databases are schema v18; `runMigrations` accepts v17 as the
oldest baseline, applies v17 → v18, the consolidated v18 → v25 step, then
v25 → v26. Legacy files under the previous `objects/<namespace>/…` layout are
workspace state removed with that migration's cache drop, not a live-key
reconcile.
