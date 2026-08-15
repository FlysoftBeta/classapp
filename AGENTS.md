# ClassApp Architecture

ClassApp is a React SPA with a custom Node.js runtime. It does not use Next.js.

## Directory map

```text
client/                 Browser-only React application
  api/                  Typed OneShot facade and raw HTTP helpers
  components/           React UI
  hooks/                React presentation adapters
  data/                 Raw IndexedDB mechanisms and normalized stores
  interact/             Client business logic, sync and remote orchestration
  lib/                  Browser-side pure logic and virtualization
  runtime/              Application update manager
  store/                Zustand state
server/                 Node.js runtime and business backend
  actions/               OneShot handlers
  data/                  All SQL/database primitives
  domain/facade/         Public business APIs and Actor-dependent orchestration
  http/routes/           Raw HTTP uploads/downloads/rendering only
  infra/                 Database, files, runtime config and update plumbing
  protocol/              WebSocket protocol and Zod registry
  runtime/               Process Runtime, request Scope, Actor, Facts and UnitOfWork
  services/              Independent business mechanisms and side effects
  validation/            Server-side semantic validation
shared/                 Types, wire protocol and pure cross-runtime logic
shell/                  Stable production bootstrap document
launcher/               Version switching and process management
```

## Boot chain

```text
launcher/launcher.js -> server.js -> server/main.mjs
```

The launcher owns version directories, dependency refresh, update confirmation,
rollback, and Windows compatibility. It passes runtime data to `server.js` over
IPC. `server.js` only installs that runtime contract and loads the compiled Node
bundle. Do not place business logic in either file.

Production serves the stable `shell.html`, which loads the active monolithic
client bundle from IndexedDB. The running application checks and installs its own
updates. Development uses `server/dev.ts` and Vite directly, bypassing Shell and
IndexedDB while preserving React Fast Refresh.

## Backend boundaries

Dependencies flow in one direction:

```text
WebSocket/HTTP Transport -> Action -> Facade/ActorFacade -> Service -> Data
```

- `server/protocol/*` owns framing, connection state and Zod request validation.
- `server/actions/*` maps a valid request to one public Facade operation.
- `server/domain/facade/*` is the public business API. It performs Actor gates,
  selects legitimate business paths, and wires independent Services. It never
  contains SQL.
- `server/services/*` owns independent mechanisms, domain invariants, events
  and side effects. Services do not scatter Actor authorization through their
  objective APIs.
- `server/data/*` is the only location allowed to contain SQL.
- `server/http/routes/*` is reserved for operations that genuinely need raw HTTP
  semantics: multipart upload, blob/download, PDF rendering and endpoint discovery.

`Runtime` owns process-bound resources. `Scope` is a cheap request context in
`AsyncLocalStorage` and lazily reuses Actor, Facades and stateful Services with
get-or-init semantics. Request-local caches are `Facts`; their owning Service
must update or invalidate them after writes. Checked errors describe recoverable
state inconsistency; malformed requests and internal failures remain unchecked
exceptions. Do not flatten these categories.

## Client boundaries

`client/data/*` owns raw IndexedDB mechanisms only. `client/interact/*` owns
remote/local selection, synchronization, proposal arbitration, reconnect
recovery and quota policy. React must not import `client/data` directly or make
its own online/offline choice. EventBus notifications use the same WebSocket;
after disconnect, access and snapshots recover before queued events are replayed.

Do not add another persistence/cache layer. The detailed client invariants are
defined in [docs/client-model.md](./docs/client-model.md).

For bidirectional infinite scrolling, follow [INFINI.md](./INFINI.md).

## Editing conventions

- Preserve the layer boundaries even when doing so requires more files or call-site
  changes.
- Migrate directly; do not leave compatibility shims.
- Obsolete files may be deleted directly.
- Keep `launcher.js` Windows-compatible.
- Treat CORS, multi-port serving, WebSocket upgrade, Shell caching and application
  update activation as one interconnected runtime contract.
