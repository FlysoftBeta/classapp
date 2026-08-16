# ClassApp working guide for agents

ClassApp is a React SPA with a custom Node.js/SQLite runtime for a small school
intranet. It runs on Chrome 70–80, including shared or managed devices, and must
remain useful while the server is unavailable. These conditions matter more
than generic Internet-SaaS conventions.

This is a quick orientation and workflow guide. `docs/` is the project's design
memory: it records intent, failure analysis, and current mechanisms, but is not
an infallible specification. Verify it against the code, schemas, and product
premise. When they disagree, investigate and update the relevant explanation
instead of mechanically choosing one side.

Start with [the documentation index](./docs/README.md). Root
`ARCHITECTURE.md` is historical context.

## Project and architecture map

```text
client/
  components/       React screens and ephemeral interaction, grouped by domain
  hooks/            React lifecycle/presentation adapters
  interact/         use cases, resources, Zustand projection, sync and recovery
  interact/remote/  WebSocket transport, session bindings, remote client
  api/              typed Action and raw-HTTP adapters
  data/             IndexedDB schema, migration, repository, coverage and files
  lib/              browser mechanisms: bundle manager, readers, pure helpers
server/
  boot.ts/main.ts    production IPC bootstrap and HTTP/HTTPS runtime assembly
  protocol/         WebSocket connection, framing, registry and error encoding
  actions/          thin validated Action-to-Facade adapters
  domain/facade/    public Actor-dependent business paths
  services/         domain and operational mechanisms; AI lives in services/ai/
  data/             all domain SQL and row mapping
  validation/       semantic input validation shared by entry paths
  runtime/          Runtime, Scope, Actor, Facts, UnitOfWork and composition
  storage/          ObjectStore blobs/trees, path containment, quota service
  http/             raw HTTP handler and generated Service Worker
  http/routes/      upload, download, rendering, Range and discovery adapters
  infra/            DB bootstrap, files, renderer, config and update mechanisms
shared/
  protocol/         correlated Action/wire/result schemas
  types/            semantic API and event DTOs
  */                pure domain primitives for posts, sync, bundles, etc.
shell.html          stable production loader; Service Worker is served by server
launcher/           process/version activation, confirmation and rollback
scripts/            builds/, dev/, operation/ and tests/
docs/               engineering design memory and system guides
```

The basic server direction is:

```text
Transport → Action / HTTP adapter → Facade / ActorFacade → Service → Data
```

- Facades select legitimate Actor-dependent business paths.
- Services own coherent objective mechanisms and side effects.
- Data owns SQL and row mapping.
- Runtime owns process-lifetime resources. Scope owns one request and lazily
  composes Actor, Facades, Services, Facts, and UnitOfWork.
- Raw HTTP routes are for operations that genuinely need HTTP semantics such as
  uploads, downloads, ranges, rendering, or discovery.

Read [architecture](./docs/architecture.md) and
[lifetimes](./docs/foundations/lifetimes-and-ownership.md) before changing these
relationships.

The basic client direction is:

```text
component → hook/presentation adapter → client/interact
                                     → client/api and/or client/data
```

- Interact owns local/remote choice, normalization, proposals, coverage,
  reconnect recovery, retention, and quota.
- `client/data` owns IndexedDB representation and atomic primitives.
- Zustand is rebuildable presentation state, not another durable repository.
- Components express intent and render state; they do not own persistence,
  authorization, synchronization, or online/offline policy.

Read the [offline overview](./docs/offline/README.md) and
[frontend state guide](./docs/systems/frontend-state-and-ui.md) before changing
this flow.

Production boot is different from development:

```text
launcher/launcher.js → server.js → bundled server runtime
stable shell.html → active monolithic client bundle in IndexedDB
```

The monolithic bundle is intentional. Shell, HTTPS, ports, WebSocket upgrade,
client activation, version switching, confirmation, and rollback form one
production path.

## Quick index for common changes

Use this table as a starting point, then follow imports/callers and adjacent
documents. The paths are orientation, not a substitute for tracing the flow.

| Change area                                      | Typical code starting points                                                                                                                                                                                          | Read first                                                                                                                                                                                               |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| product premise, new dependency, compatibility   | `package.json`, `vite*.config.ts`, affected client/build code                                                                                                                                                         | [product context](./docs/product-context.md), [coding standards](./docs/engineering/coding-standards.md), [known traps](./docs/engineering/traps.md)                                                     |
| server schema, SQL, migration, materialized data | `server/infra/db.ts`, `server/data/`, owning Service                                                                                                                                                                  | [server data model](./docs/foundations/server-data-model.md), [transactions and events](./docs/foundations/invariants-and-transactions.md)                                                               |
| client schema or offline domain data             | `client/data/schema.ts`, `client/data/migration.ts`, `client/data/model.ts`, `client/data/repository.ts`                                                                                                              | [local data model](./docs/offline/local-model.md), [consistency and recovery](./docs/offline/consistency-and-recovery.md), [storage and quota](./docs/offline/storage-and-quota.md)                      |
| sync, proposals, coverage, reconnect             | `client/interact/sync.ts`, `consistency.ts`, `remoteLifecycle.ts`, domain interact module                                                                                                                             | [consistency and recovery](./docs/offline/consistency-and-recovery.md), [RemoteManager connection reliability](./docs/offline/remote-connectivity.md), [offline overview](./docs/offline/README.md)                     |
| Runtime, Scope, Actor, Facts, transactions       | `server/runtime/`, `server/runtime/composition.ts`                                                                                                                                                                    | [lifetimes and ownership](./docs/foundations/lifetimes-and-ownership.md), [transactions and events](./docs/foundations/invariants-and-transactions.md)                                                   |
| authentication, client trust, roles, validation  | `server/domain/facade/authentication.ts`, `server/services/authService.ts`, `server/services/clientsService.ts`, `server/services/authorityService.ts`, `server/services/roleService.ts`, `server/validation/`        | [authentication](./docs/systems/authentication.md), [authority, validation, and audit](./docs/foundations/authority-validation-audit.md), [security](./docs/foundations/security-threat-model.md)        |
| Groups, conversations, Posts, Articles           | matching files in `server/domain/facade/`, `server/services/`, `server/data/`, `client/interact/`; UI in `client/components/chat/`, `client/components/articles/`, `client/components/sidebar/`                       | [community and content](./docs/systems/community-and-content.md), plus offline data/consistency docs when cached                                                                                         |
| React UI, resources, Zustand, large lists        | `client/components/`, `client/hooks/`, `client/interact/resources.ts`, `client/interact/appStore.ts`, `client/lib/`                                                                                                   | [frontend state and UI](./docs/systems/frontend-state-and-ui.md), [infinite scrolling](./docs/systems/infinite-scrolling.md)                                                                             |
| documents, PDF rendering, offline bundles        | `server/domain/facade/articles.ts`, `server/services/articlesService.ts`, `server/data/articles.ts`, `server/infra/pdfRenderProcess.ts`, `server/storage/renderArchive.ts`, `client/interact/bundles.ts`, `lib/poppler` | [document rendering](./docs/systems/document-rendering.md), [storage and quota](./docs/offline/storage-and-quota.md)                                                                                     |
| server objects, tree archives, quota eviction    | `server/storage/`, `server/data/quota.ts`, `server/runtime/mediaRuntime.ts`, `server/runtime/teachDocumentsRuntime.ts`, `server/services/teachDocumentsService.ts`, `server/services/ai/aiWorkspace.ts`                                                | [server object storage and quota](./docs/systems/server-storage.md), [lifetimes and ownership](./docs/foundations/lifetimes-and-ownership.md)                                                               |
| music, media playback, yt-dlp packaging          | `server/runtime/mediaRuntime.ts`, `lib/media/`, `server/services/mediaService.ts`, `server/services/mediaPlaylistService.ts`, `server/data/media.ts`, `client/interact/media.ts`, `client/components/media/`, `scripts/builds/build-media.mjs` | [music and media runtime](./docs/systems/music.md), [storage and quota](./docs/offline/storage-and-quota.md), [repository infrastructure](./docs/engineering/repository-infrastructure.md) |
| AI conversations, workspace, provider or billing | `server/services/ai/`, `server/domain/facade/ai.ts`, `client/interact/ai.ts`, `client/components/ai/`                                                                                                                 | [AI harness](./docs/systems/ai-harness.md), [AI billing](./docs/systems/ai-billing.md)                                                                                                                   |
| startup, HTTPS, Shell, bundle or server update   | `shell.html`, `client/lib/bundle.ts`, `client/data/shellSchema.ts`, `server/boot.ts`, `server/main.ts`, `server/infra/update/`, `launcher/`, `scripts/builds/`                                                        | [update and startup](./docs/systems/update-and-startup.md), [Shell and HTTPS](./docs/offline/shell-and-https.md), [repository infrastructure](./docs/engineering/repository-infrastructure.md)           |
| Incident, audit, operations, administration      | `server/domain/facade/incidents.ts`, `server/domain/facade/audit.ts`, `server/domain/facade/administration.ts`, corresponding Services/Data, `client/components/admin/`                                               | [errors and Incidents](./docs/foundations/errors-and-incidents.md), [observability and operations](./docs/systems/observability-and-operations.md), [admin workbench](./docs/systems/admin-workbench.md) |
| scripts, build, tests, documentation             | `scripts/`, `package.json`, `vite*.config.ts`, `docs/`                                                                                                                                                                | [repository infrastructure](./docs/engineering/repository-infrastructure.md), [testing](./docs/engineering/testing.md), [documentation maintenance](./docs/engineering/documentation.md)                 |

## Development, scripts, and tests

`npm run dev` builds the browser Wasm prerequisites, then starts the Node
development server on port 3001 and Vite on port 3000. Vite bypasses the
production Shell and bundle-installation path.

```text
npm run lint                 TypeScript and ESLint after prerequisite builds
npm run build -- <target>   Build linux-redhat, linux-debian, or windows
npm run media:update        Refresh pinned media artifacts and POT cache
npm run test:e2e            Chrome 70 HTTPS/install/offline/reconnect path
npm run test:manual         Current manual production harness
npm run test:manual-legacy  Legacy-browser manual harness
```

Run `npm run media:update` once after cloning (and again when bumping yt-dlp
or the POT provider); dev and release builds then resolve verified media
artifacts from `.cache/media`.

There is no general unit-test runner. Co-located `*.test.ts` files may typecheck
without executing. Use a bounded `.cache` or shell probe for temporary work;
maintained executable scenarios currently belong under `scripts/tests/`.

Infrastructure ownership:

- `scripts/builds/` — prerequisite and release assembly;
- `scripts/dev/` — development orchestration and reset/update tools;
- `scripts/operation/` — narrow operator/build-host workflows;
- `scripts/tests/` — maintained system and manual harnesses;
- `worktree/` — ignored runtime state and secrets;
- `.cache/` — reconstructible intermediates and temporary probes;
- `build/` — final release archives.

See [repository infrastructure](./docs/engineering/repository-infrastructure.md)
and [testing](./docs/engineering/testing.md) for exact behavior.

## Working flow

1. Inspect the working tree and preserve unrelated user changes.
2. Identify the relevant product constraints before importing a familiar
   dependency, abstraction, or “best practice.”
3. Use `docs/README.md` to find the relevant design memory, then trace the real
   producer-to-consumer path in code. Do not infer architecture from one file or
   imitate a pattern merely because it exists.
4. For a nontrivial change, identify the domain fact, owner, lifetime, stable
   identity, transaction/publication boundary, failure windows, and recovery.
   Cross-stack work may require tracing UI, protocol, Facade, Service, Data,
   events, client merge, offline retention, and reconnect repair.
5. Implement through the existing owners. Prefer a coherent migration over two
   representations living indefinitely, while distinguishing irreplaceable
   server data from reconstructible client projections.
6. Update relevant documentation while code and understanding evolve. Do not
   wait until the end or duplicate detailed rules in AGENTS. Correct descriptions
   of mechanisms in the same change; explain changes to design intent.
7. Verify the boundary and failure case actually affected. Review the complete
   diff and report what ran, what did not, and what risk remains.

The fuller design prompts are in
[agent-method.md](./docs/engineering/agent-method.md); they are not a ceremony
required for every small edit.

## Maintaining documentation

- Keep AGENTS as a fast project/workflow guide. Put detailed subsystem reasoning
  in its owning document and link to it instead of copying it here.
- Distinguish product constraints, design intent/invariants, current mechanisms,
  preferences/cautions, and open limitations. Do not turn a preference or one
  current implementation into an unconditional rule.
- Give each detailed idea one home. Extend an existing topic document before
  creating another; add genuinely new documents to `docs/README.md`.
- Document why an ownership boundary, protocol, or unusual mechanism exists and
  which failure it prevents. Avoid mirroring functions and classes that the code
  already describes.
- Update documentation during investigation and implementation. Remove obsolete
  explanations and links as part of a direct migration; leave unresolved
  conflicts explicit rather than writing around them.
- Preserve established project terminology and English documentation style.
  Check relative links and formatting before handoff.

The full writing and maintenance guide is
[documentation.md](./docs/engineering/documentation.md).

## Questions to keep asking

### Code organization

- Which layer owns this fact or consequence? Is the logic merely in the easiest
  caller or an already-large accidental module?
- Does this introduce a second truth, cache, activation pointer, permission
  check, or representation?
- Does a generic helper hide a missing owner? Can context, locks,
  subscriptions, timers, or temporary files outlive their operation?

### Compatibility and deployment

- Does it actually work in Chrome 70–80, including syntax, CSS, Web APIs,
  IndexedDB, workers, Wasm, and transitive dependencies?
- Am I testing Vite while the affected behavior belongs to Shell, HTTPS,
  Service Worker, launcher, packaging, or rollback?
- Does the expected scale justify the complexity, and does packaging still work
  on both Linux and Windows?

### Data models and consistency

- Is this an objective fact, Actor projection, local user decision, or
  reconstructible materialization? What is its stable identity and owner?
- What do its cursor, revision, coverage, generation, or pointer certify? Can it
  be published before the represented data is durable?
- If a mutable value is duplicated, who updates, detects, and repairs every
  copy? Which states truly need one transaction?
- Can stale responses, events, reconnect, Actor switching, or partial writes
  erase newer intent? Can server repair preserve local-only decisions?

### UI organization and design

- Is the UI rendering canonical/interact state and expressing intent, or has it
  acquired business, persistence, authorization, or sync policy?
- Should this state be durable IndexedDB domain state, shared Zustand
  presentation state, or ephemeral component interaction?
- Does the UI distinguish useful stale data, loading, confirmed absence,
  inadequate offline coverage, checked rejection, and unexpected Incident when
  that distinction matters?
- Are stable identity, keyboard/accessibility behavior, bounded rendering,
  narrow screens, and Chinese-content layout preserved?

Concrete guidance on schemas, secrets, materialization, transactions, recovery,
compatibility, and test placement belongs in
[coding standards](./docs/engineering/coding-standards.md),
[server data model](./docs/foundations/server-data-model.md),
[offline consistency](./docs/offline/consistency-and-recovery.md), and
[known traps](./docs/engineering/traps.md).

## Finishing a change

Choose verification proportionally. `npm run lint` is the common type/lint
check; production build, Chrome 70 E2E, migration exercise, or platform testing
is needed when that boundary changed. Vite does not validate production, and
compilation does not execute co-located tests.

Before handoff, state the behavior and failure cases verified, exact commands or
manual checks, anything skipped, migrations/cleanup/documentation handled, and
remaining uncertainty without disguising it as success.
