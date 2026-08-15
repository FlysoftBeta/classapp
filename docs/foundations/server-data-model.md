# Server data model and migration discipline

The server database is the durable authority. In the examined working tree it
uses SQLite schema v22 and accepts v17 as the oldest migration baseline. Unlike
the reconstructible browser projection, server rows are not casually nuked.

## Table families

| Family              | Tables and meaning                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------- |
| identity            | `users`, `deleted_users`, `user_pins`, `sessions`, `ghost_users`                            |
| authority           | `user_admin_roles`, feature bitset on `users`, `admin_audit_log`                            |
| clients             | `clients`, `client_ips`, `client_associations`, `client_attempts`, `client_last_active`     |
| community           | `groups`, `group_members`, `dms`, `posts`, `convs_user`                                     |
| articles            | `articles`, `text_article_segments`, `article_bookmarks`, `article_read_progress`           |
| AI conversation     | `ai_conversations`, `ai_messages`, `ai_runs`, `ai_run_attempts`, tags and context snapshots |
| AI accounting/tools | policy, enrollments, accounts, reservations, usage, ledger, file operations                 |
| learning            | `words`, `user_word_progress`                                                               |
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

Database rows may name article archives, source files, AI ZIP workspaces, teaching
document blobs, backups, or deployment metadata. SQLite cannot transact with the
filesystem. Each owner documents staging, atomic publication, compensation,
orphan GC, and purge. A raw relative path from the client never becomes a host
path without normalization and root containment.
