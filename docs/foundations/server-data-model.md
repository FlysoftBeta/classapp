# Server data model and migration discipline

The server database is the durable authority. In the examined working tree it
uses SQLite schema v27. Production deployments are schema v18; development
snapshots may still be v17. Migrations accept v17 as the oldest baseline:
v17 → v18, then one consolidated v18 → v25 step, then v25 → v26, then
v26 → v27. Unlike
the reconstructible browser projection, server rows are not casually nuked.
v26 drops reconstructible cache (media bytes, teach copies, bundle articles,
old quota ledger) and switches remaining blobs to allocated `blob_id`s.
v27 replaces playlist `owner_user_id` with principal access bindings, adds
booklists as an articles-domain collection (`booklists` / `group_booklists`),
capability possession, and treats group-chat articles as ownerless objects.

## Table families

| Family              | Tables and meaning                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------- |
| identity            | `users`, `deleted_users`, `user_pins`, `sessions`, `ghost_users`                            |
| authority           | `user_admin_roles`, feature bitset on `users`, `admin_audit_log`                            |
| clients             | `clients`, `client_ips`, `client_associations`, `client_attempts`, `client_last_active`     |
| community           | `groups`, `group_members`, `dms`, `posts`, `convs_user`                                     |
| articles            | `articles`, `text_article_segments`, `article_read_progress`, `booklists`, `booklist_items`, `group_booklists` |
| media               | `media_tracks`, `media_assets`, `media_lists` (`playlist` / `queue`), `media_list_items`, `user_queues`, `media_stream_grants` |
| access              | `access_bindings`, `access_effective`, `resource_possession`, `user_favorites`, `user_recents` |
| AI conversation     | `ai_conversations`, `ai_messages`, `ai_runs`, `ai_run_attempts`, tags and context snapshots |
| AI workspace        | `ai_workspaces` (ready `blob_id` plus in-flight `staging_blob_id`)                          |
| AI accounting/tools | policy, enrollments, accounts, reservations, usage, ledger, file operations                 |
| learning            | `words`, `user_word_progress`                                                               |
| storage quota       | `storage_quota_pools`, `storage_quota_items` (heat ledger; `cache` vs `durable`)            |
| operations          | `incident_groups`, `incidents`, `teach_documents`, `config`, user configuration             |

This is not a table-oriented architecture. Each Data module owns the SQL for a
domain mechanism; cross-table business workflows are composed through Services
and Facades.

## Identity and references

- Stable UUID/string IDs are primary and foreign keys.
- Handles are unique active-user/group labels but may be released/reused after
  lifecycle changes; historical identity remains ID-based.
- `conv_id` references a union of Group and DM. SQLite triggers/Service logic
  enforce union existence where an ordinary foreign key cannot.
- Post row identity/order is immutable; deletion is a tombstone update.
- Article provider JSON is validated and describes immutable text/bundle
  materialization.
- Deleted user rows retain historical display identity while active-user reads
  exclude them.

## Materialization and duplicated facts

Materialization is a consistency protocol, not a query convenience. Before
copying a mutable fact into another table, name:

- the authoritative row and stable identity;
- every writer and invalidation/update path;
- whether old snapshots, offline revisions, audit, exports, and migrations can
  observe disagreement;
- the query or availability requirement that justifies the copy;
- how divergence is detected and repaired.

For example, copying a mutable display name from the identity owner into every
content row would make rename semantics and migration part of that content
owner's protocol. A join, side bundle, or intentionally historical snapshot may
each be correct; choose based on the required meaning rather than query
convenience alone. The browser's concrete normalized identity model is covered
by [local data ownership](../offline/local-model.md).

This is not a universal ban on materialized views. Immutable publication
snapshots, deliberate historical display values, search indexes, and measured
read models can justify duplication. Their staleness semantics and rebuild
owner must be part of the design rather than left to incidental writes.

## JSON and bitsets

JSON columns require valid JSON checks and a typed parser at the Data boundary.
Do not pass raw JSON strings upward. A discriminant (`type`) defines provider or
content variants; adding a variant updates schema validation, row mapping,
shared DTOs, client normalization, purge, and tests.

Feature bitsets are private storage compression. Administrative roles have an
explicit relational table because prerequisites, grant provenance, and querying
are domain data rather than opaque bits.

## Transactions and constraints

Use database constraints for structural impossibility:

- uniqueness and stable compound identities;
- foreign references/cascades where semantics match;
- check constraints for state enums and JSON validity;
- partial unique indexes such as one active AI run per conversation;
- triggers for union references or immutable identity where necessary.

Service semantic checks provide useful public errors, but constraints remain the
last defense against races. Do not catch every constraint and convert it to a
generic success/absence.

## Migration ledger

`config.schema_version` is advanced in the same transaction as each ordered
migration. Startup:

1. creates the version ledger when missing for a newly installed current
   schema;
2. rejects corrupt, too-old, or future versions;
3. looks up every `v → v+1` migration without gaps;
4. executes schema/data change and version advance atomically;
5. installs idempotent current declarations/seed invariants.

A migration must be safe for the precise source schema, not merely idempotent on
the current schema. Never edit an already-shipped migration's meaning; append a
new migration. Do not dual-write old/new columns.

For a destructive or representation migration:

- back up and test with a production-shaped database;
- calculate bounds and integer-unit conversion explicitly;
- preserve last-root/admin recovery;
- reconcile dependent files and process operations;
- verify the new application cannot start against the old schema and vice versa
  except through the launcher rollback pair;
- test update rollback restores the database backup matching the old app.

## Query discipline

- Keyset pagination uses indexed order plus stable ID tie-breaker.
- Avoid correlated per-row lookups where a join or side bundle works.
- Add indexes from measured access paths and inspect query plans.
- Dynamic SQL fragments are closed enums owned by Data; values are parameters.
- Do not add exact totals to infinite-scroll endpoints without a product need.
- Maintenance queries are bounded and must not block normal requests for long.

## File relationships

Database rows may name article blobs, AI workspace trees, teaching document
blobs, media assets, backups, or deployment metadata. All application blobs
live below `server/storage/`: an allocated UUID `blob_id` maps to a sharded
host path, single blobs are raw streamed files, and complex objects are
manifest-based ZIP trees. Owner tables keep the authoritative reference and
lifecycle; `storage_quota_items` is an accounting ledger, not a second owner.
Quota pools are configured by the mechanism that pays for their weight.

SQLite cannot transact with the filesystem. Each owner documents staging,
atomic publication, compensation, and purge. A raw relative path from the
client never becomes a host path. Blob ids are allocated server-side UUIDs
and are never client-controlled filesystem paths. Physical GC walks only
`staging/` and `trash/`; it must not scan `objects/` minus a live-key list.
