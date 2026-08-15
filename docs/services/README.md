# Service contracts

A Service is a coherent mechanism, not an authorization surface and not a
lifetime marker. Services are request-bound by default, are lazily reused by
`Scope`, and may own request-local Facts. Process-bound mechanisms use the
`Runtime` suffix.

## Identity and authority

| Service            | Mechanism, owned state, and boundary                                                                                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AuthService`      | Login/OOBE/session creation and client binding. PIN hashes and session tokens stay server-side. It does not decide administrative authorization.                                       |
| `AuthorityService` | Resolves the current Actor and owns the Actor user/ban Facts. Its public checks are small Facade primitives, not a capability language. Mutations of the current user invalidate it.   |
| `RoleService`      | Validates and replaces orthogonal administrative roles in one transaction, including prerequisites and last-root recovery. Only root-gated Facades call replacement.                   |
| `UserService`      | User identity, profiles, PINs, mute/ban state, semantic feature settings, deactivation, and identity deletion. It owns user invariants but not who may perform an administrative path. |
| `GhostUserService` | Short-lived pre-OOBE identities and collision-free PIN generation. It does not create active users itself.                                                                             |
| `ClientService`    | Device identity, whitelist/binding state, login throttling, and client lifecycle. Raw IP/MAC/user-agent evidence remains server-side.                                                  |

## Communication and content

| Service                | Mechanism, owned state, and boundary                                                                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GroupService`         | Group structure, discovery, membership, and group settings. It owns request-local membership Facts and updates them after add/remove for read-your-writes.                       |
| `ConversationService`  | Conversation directory, revisions, read/pin/mute/draft state, and participant notifications.                                                                                     |
| `PostService`          | Objective Post creation, revisioned updates/tombstones, pagination, metadata bundles, and events. Actor membership/ownership/moderation paths are selected by `PostActorFacade`. |
| `ArticleService`       | Objective text/bundle records, progress, bookmarks, artifacts, and article events. Membership, feature, ownership, and moderation decisions live in `ArticleActorFacade`.        |
| `ArticleImportService` | Request view of `ArticleImportRuntime`; search/list/start only. The Runtime owns the external pool, queue, and tasks that outlive a request.                                     |
| `StickerService`       | Sticker catalog and pack access. Post creation still enters through `PostActorFacade`.                                                                                           |
| `AnnouncementService`  | Announcement content and publication state. Administrative publication is gated by its Facade.                                                                                   |

## AI and billing

| Service               | Mechanism, owned state, and boundary                                                                                                                                                            |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AiService`           | Conversation tree, routing, streaming runs, and workspace tools. It asks `AiBillingService` to reserve and settle usage; provider calls occur outside SQLite transactions.                       |
| `AiBillingService`    | Daily/weekly plan windows, top-ups, reservations, idempotent settlement, ledger views, policy updates, plan assignment, and system stock/consumption aggregation. It makes no Actor role decision. |
| `AiExecutionRuntime`  | Process-bound active-run cancellation and restart reconciliation. It stores controllers, never request Scope.                                                                                   |
| `AiFileStore` helpers | Atomic ZIP workspace mechanism with a catalog and size/type limits. They are internal to `AiService`, not public business APIs.                                                                 |

See [AI billing](./ai-billing.md) for accounting and precision rules.

## Application administration and operations

| Service                                            | Mechanism, owned state, and boundary                                                                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AppStateService`                                  | Public application flags and authenticated/anonymous state projections. Product features are semantic booleans.                                              |
| `AdminSystemService`                               | Backups, update lifecycle, rollback, deployment, and narrowly scoped host tools. Role selection and audit orchestration live in `AdministrationActorFacade`. |
| `HttpsUpgradeService`                              | HTTPS certificate/status inspection and redirect setting. It owns no Actor policy.                                                                           |
| `IncidentService`                                  | Checked/public error classification, durable incident grouping, and correlation IDs at containment boundaries.                                               |
| `IncidentLogArchiveService`                        | Process log archive generation for the operations download path.                                                                                             |
| `AuditService`                                     | Append-only summaries of successful administrative mutations. It excludes PINs, tokens, bodies, and other secrets.                                           |
| `TeachDocumentsService`                            | Captures, retains, downloads, and cleans up office teaching documents and their blobs.                                                                       |
| `NotificationConfigService`                        | System notification settings and their domain projection.                                                                                                    |
| `UserConfigService` / `VersionedUserConfigService` | Raw internal configuration mechanism and versioned user decisions respectively. Actor ownership is enforced by Facades.                                      |
| `WordsService`                                     | Learning words, review state, and user purge behavior.                                                                                                       |

## Internal modules that are not Services

`postContent`, AI prompts/pricing/harness, maintenance scheduling, and office
monitoring are supporting mechanisms. Their filenames do not make them public
business APIs. `EventBusRuntime` is owned by process `Runtime`; Services use its
typed publish helpers and never locate a database globally.

## Contract checklist

When adding or materially changing a Service, document:

1. mechanism and exclusions;
2. public operations and domain invariants;
3. owned Data/files and collaborators;
4. Facts and read-your-writes invalidation;
5. transaction/event/idempotency/failure semantics;
6. purge/deactivation and audit behavior.
