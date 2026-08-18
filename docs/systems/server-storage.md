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
   response cannot mix one file's length with another file's body.
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

Maintenance runs BlobStore GC, quota cache sweeps for registered owners, and
each owner's own stale-intent cleanup. It does not walk `objects/`.

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
