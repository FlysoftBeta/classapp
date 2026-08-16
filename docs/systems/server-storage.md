# Server object storage and quota

Feature-owned blob directories (`aiFileStore`, `teachDocumentBlobs`,
`mediaStore`, article artifact helpers) previously reimplemented path checks,
staging, streaming, and eviction independently. They are replaced by one
mechanism under `server/storage/`; domain code keeps only product policy.

## Object model

```text
server/storage/
  paths.ts           namespace/key validation and content-sharded layout
  objectStore.ts     streaming single-blob reads/writes, stage/commit, trash
  treeStore.ts       manifest-based ZIP complex objects
  renderArchive.ts   document-specific STORED-ZIP index over a blob object
  quotaService.ts    DB-backed accounting and eviction loop
  storageRuntime.ts  process-bound ObjectStore + dynamic evictor registry
server/data/quota.ts            quota SQL, min/max ranges, bounded ranking
```

A reference is `(namespace, key)`. Namespaces are a closed enum
(`ai-workspaces`, `media`, `teach-documents`, `article-bundles`). Keys are
owner-chosen opaque segments (`bundleId/render`, `trackId/audio`, user UUID);
they are validated as `[A-Za-z0-9][A-Za-z0-9._-]*` segments and are never
host paths. The on-disk name is only a SHA-256 digest of the reference, sharded
into two directory levels, so user IDs and traversal input cannot influence
layout.

Single blobs have no metadata wrapper: put streams into a staging file with an
incremental SHA-256, fsyncs, and atomically renames. Reads open one file
descriptor and derive both size and Range from that descriptor, so a response
can never mix one file's length with another file's body. Publication validates
the staged bytes before the rename; if a platform still reports a replacement
conflict the previous materialization is retired through trash rather than
deleted, and startup trash reconciliation compensates the intervening window.

Complex objects use one ZIP with:

- `manifest.json` — format/version/revision and one entry per logical file
  (`id`, `path`, `mime`, `size`, `sha256`, `updatedAt`); no per-file sidecars;
- `objects/<uuid>` — content-addressed payloads.

The TreeStore validates the manifest, duplicates, payload sizes, and limits
under one per-object lock, applies a mutation to a working copy, then
republishes the whole archive atomically. It is intentionally bounded; AI
workspace limits are 10 MiB payload / 256 files / depth 3. This is the
"lightweight SquashFS" role previously duplicated by `aiFileStore`. The archive
is fully re-parsed and checksummed before publication and is verified again
from the committed object.

`renderArchive.ts` is not generic storage: it validates the renderer's
untrusted archive contract and builds an offset index, then streams selected
STORED ranges through the same ObjectStore API.

## Orphan compensation

SQLite cannot commit with the filesystem. The storage runtime therefore
maintains authoritative live-key collectors per namespace (`server/data/
storageReferences.ts`): media ready assets, teach-document rows (including
capturing intents), bundle article rows plus upload intents, and AI workspace
users. On startup and during maintenance, `ObjectStore.reconcileOrphans`
compares the objects directory against those collected keys and moves
unreferenced `.object` files into trash. This is the compensation for crashes
between object publication and row publication; owners do not need their own
orphan sweeps.

## Quota

SQLite tables:

- `storage_eviction_groups(name, max_bytes, target_ratio, min_age_ms)`;
- `storage_quota_items(group_name, item_key, bytes, touch_time_ms,
touch_freq, created_at_ms)`.

Groups are **dynamic**: the owning mechanism passes its policy to
`StorageRuntime.registerEvictor` or creates/updates it with `QuotaService`.
There is no seeded registry, and `QuotaService` is stateless over one database
handle. Request Services construct it on demand; process maintenance constructs
another instance. It is a Service because it owns SQL-backed policy, not
because it is Request-bound.

A touch persists:

```text
touch_freq = (old_touch_freq + (touch_time - old_touch_time)) / 2
```

Candidates are ranked with min-max normalized size, touch time, and touch
frequency:

```text
score = 0.5·norm(bytes) + 0.3·(1 - norm(touch_time)) + 0.2·(1 - norm(touch_freq))
```

The normalization ranges come from SQL `MIN/MAX` aggregate queries over the
per-group indexes (`group_name, bytes`, `group_name, touch_time_ms`,
`group_name, touch_freq`), and the ranked candidate query applies `ORDER BY
score DESC ... LIMIT ?` in SQLite. Node.js only receives bounded batches; it
never materializes a group or computes range aggregates over a whole group.
Startup backfill for pre-ledger media/teaching rows is an `INSERT ... SELECT`
upsert, not a Node-side scan.

Larger, older, less frequent items score higher and are evicted first.
Reconciliation visits only registered evictor groups, runs age sweep first
(`touch_time_ms < now - min_age_ms`), then high-watermark sweep while
`SUM(bytes) > max_bytes`, targeting `max_bytes * target_ratio`. Candidate
revalidation re-reads the current item and refuses stale snapshots; only the
owner-provided evictor deletes domain rows and files in the correct order.
Orphan quota rows whose group no longer exists are swept before policy work.

Owner evictors:

- `media`: `MediaRuntime` checks stream leases and `ref_count = 0`
  compare-and-delete, then trashes both asset objects.
- `teach-documents`: `TeachDocumentsRuntime` trashes the object and removes
  the metadata row; `TeachDocumentsService` downloads touch the item.
- `article-bundles` and per-user `ai-workspaces:<id>` groups are accounting
  only; no automatic eviction is configured for them.

## Migration

Schema v25 installs the quota tables, the `article_uploads` intent table, and
the `teach_documents.status` capture state. Production databases are schema
v18; `runMigrations` accepts v17 as the oldest baseline, applies the original
v17 → v18 step, then one consolidated v18 → v25 migration containing every
later change in order. Text articles are pure SQL and are preserved. Bundle
articles, their upload intents, and teach documents were
work-in-progress at this boundary, so the consolidated migration deletes those
rows as part of the same schema-version step; there is deliberately no
legacy layout migrator for those blob-owned features. Legacy blob directories
are workspace state removed by `npm run reset`, not by server initialization.
Multipart bundle uploads
keep a durable `article_uploads` row from authorization until the article row is
published, and stale staging rows are compensated by
`ArticleUploadRuntime.reconcile`.
