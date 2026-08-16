# Service and ownership catalog

This catalog is a navigation aid, not an argument for one document per class.
Cross-stack system documents remain authoritative for behavior.

## Process runtime and infrastructure

| Owner                   | Lifetime and responsibility                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| `Runtime`               | process composition: database, event bus, AI execution, article import                          |
| `EventBusRuntime`       | process channel fan-out; events are repair hints, not durable log                               |
| `AiExecutionRuntime`    | active run cancellation and restart reconciliation                                              |
| `ArticleImportRuntime`  | external import pool, queue, long-running task ownership                                        |
| `TeachDocumentsRuntime` | Office/WPS monitor child, capture, quota policy/ledger, owner eviction                          |
| launcher                | version directories, child restart, pending metadata, rollback watchdog                         |
| `UpdateManager`         | server-side validation/staging/cloud status; should be Runtime-owned rather than global locator |
| `BundleManager`         | browser post-bootstrap manifest check, stage, activation coordination                           |
| Service Worker          | selected Shell cache/pointer and navigation fallback only                                       |

## Request foundation

| Owner                        | Responsibility                                                    |
| ---------------------------- | ----------------------------------------------------------------- |
| `Scope`                      | immutable request identity, get-or-init request graph, UnitOfWork |
| `Composition`                | typed construction of Facades/Services                            |
| `Actor` / `AuthorityService` | request principal, user/role/feature Facts                        |
| `Facts`                      | Service-owned request-local lazy knowledge                        |
| `UnitOfWork`                 | nested transaction and post-commit effect publication             |

## Identity, authority, and administration

| Service                     | Mechanism and exclusions                                                |
| --------------------------- | ----------------------------------------------------------------------- |
| `AuthService`               | PIN/OOBE/session/client-binding authentication; not admin authorization |
| `ClientService`             | client identity, whitelist/binding/lock/throttle/lifecycle              |
| `AuthorityService`          | current Actor facts and checks; not a capability DSL                    |
| `RoleService`               | prerequisite graph, replacement transaction, last-root invariant        |
| `UserService`               | identity/profile/PIN/ban/mute/features/deactivation/deletion            |
| `GhostUserService`          | pending pre-OOBE identities and PIN generation                          |
| `AuditService`              | safe records of successful administrative decisions                     |
| `AdministrationActorFacade` | responsibility gates and operational orchestration                      |

## Community and content

| Service                | Mechanism and exclusions                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `GroupService`         | aggregation, discovery routes, membership, Group policy, membership Facts                        |
| `ConversationService`  | directory, DMs, revisions, read/pin/mute/draft and notifications                                 |
| `PostService`          | objective Post creation/current revision/tombstone/pagination/side bundles                       |
| `ArticleService`       | objective text/bundle metadata, object publication, list/progress/bookmark mechanisms and events |
| `ArticleImportService` | request view of process import runtime                                                           |
| `StickerService`       | catalog/pack mechanism; Post creation still uses Post Facade                                     |
| `AnnouncementService`  | announcement content/publication mechanism                                                       |
| `WordsService`         | learning/review state and purge behavior                                                         |

## AI

| Owner                      | Responsibility                                                      |
| -------------------------- | ------------------------------------------------------------------- |
| `AiService`                | conversation tree, routing, context, streaming runs, tools          |
| `AiBillingService`         | plan windows, top-up, reservations, settlement, ledger, aggregation |
| AI harness/prompts/pricing | internal mechanisms, not public Services                            |
| `AiWorkspace`              | AI file-tool path/content policy over the manifest TreeStore        |

## Operations and support

| Service                      | Responsibility                                                         |
| ---------------------------- | ---------------------------------------------------------------------- |
| `AppStateService`            | public/authenticated application-state projections and global settings |
| `AdminSystemService`         | backup/update/rollback/tool facade over infra mechanisms               |
| `HttpsUpgradeService`        | certificate/status/redirect setting mechanism                          |
| `IncidentService`            | grouping, public correlation IDs, bounded diagnostic capture           |
| `IncidentLogArchiveService`  | current-build diagnostic export                                        |
| `TeachDocumentsService`      | request view: admin list/download and cleanup orchestration            |
| `NotificationConfigService`  | system notification settings/projection                                |
| `UserConfigService`          | raw internal user configuration                                        |
| `VersionedUserConfigService` | independently mergeable versioned decisions                            |

## Storage and quota

| Owner                  | Responsibility                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| `ObjectStore`          | namespace/key validation, fd-based streaming blobs, staging, trash, staged/trash/orphan reconcile |
| `TreeStore`            | manifest ZIP validation, locked mutation, bounded complex objects                                 |
| `QuotaService`         | dynamic eviction groups, touch formula, bounded SQL-driven sweeps                                 |
| `StorageRuntime`       | process-bound ObjectStore, owner-provided evictor registry, live-key orphan collectors            |
| `ArticleUploadRuntime` | compensation for stale multipart bundle upload intents                                            |
| `server/data/quota`    | quota SQL, indexed min/max ranges, bounded candidate ranking                                      |

## Client ownership

| Owner                              | Responsibility                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------ |
| `client/data/schema,migration,idb` | stores, schema-owner races, leases, transactions                               |
| `client/data/repository`           | normalized persistence APIs; should be decomposed by owned mechanism over time |
| `client/data/files`                | extent generations, locks, streaming/publication                               |
| remote transport                   | WebSocket connection only                                                      |
| remote session                     | per-user token bindings and credential epochs                                  |
| remote client                      | typed request correlation, result/event validation                             |
| `ActorContext`                     | immutable actor identity for one async operation                               |
| `client/interact` use cases        | local/remote choice, normalization, proposal/coverage/recovery policy          |
| React/Zustand                      | rendering and rebuildable/ephemeral presentation state                         |

## Data ownership rule

Every server table/query belongs to a module under `server/data`. Every client
store has one repository/mechanism owner. If a new cross-Service workflow needs
to remove a user's data, add an explicit `purgeUser` operation to each owner and
update the orchestration. Do not reach into another owner's tables or stores.
