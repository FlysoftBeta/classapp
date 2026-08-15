# ClassApp

ClassApp is an offline-capable communication, reading, learning, and
administration application for a small school community. It is a React SPA with
a custom Node.js/SQLite runtime—not a Next.js application and not a generic
Internet SaaS.

The deployment premise shapes the architecture:

- the client must run on Chrome 70–80 and managed or shared devices;
- the server lives on a concealed school LAN and may be unreachable for useful
  periods of time;
- the stable production entry point must boot an application bundle already
  stored in IndexedDB;
- one Node process and SQLite writer are appropriate for the expected scale;
- updates, HTTPS, version switching, confirmation, and rollback must work
  without a conventional cloud deployment platform.

Interfaces and schemas are migrated directly while the project evolves. There
is no general backward-compatibility promise for internal APIs or local data.

## What the application does

- **Community:** nested discoverable groups, membership policy, group chat,
  direct conversations, posts, announcements, and articles. A Group represents
  a community of people and responsibilities, not merely a chat room.
- **Offline use:** normalized local projections for conversations, articles,
  access, coverage, drafts, reading state, retention, and pending user intent;
  reconnect recovery precedes replay of queued live events.
- **Reading:** segmented long text and server-rendered document bundles with
  progress, retention, quota-aware eviction, and offline access. The browser
  does not run PDF.js.
- **Learning:** word study, review state, mistakes, progress, and discipline
  prompts.
- **AI:** server-owned provider harness, per-user conversations and ZIP
  workspaces, usage accounting, quota, pricing, and billing ledger.
- **Administration:** responsibility-based authority, users and clients,
  community policy, Incidents, audit, HTTPS, backups, updates, and host
  operations.

## Architecture at a glance

Server dependencies flow inward:

```text
WebSocket / HTTP transport
        → Action or raw HTTP adapter
        → Facade / ActorFacade
        → Service
        → Data
```

- transport owns framing, connection state, streaming, and wire-shape
  validation;
- Actions map a valid OneShot request to one public Facade operation;
- Facades capture the Actor, authorize legitimate paths, and compose Services;
- Services own objective mechanisms, invariants, events, and side effects;
- `server/data` exclusively owns SQL and row mapping.

The process `Runtime` owns long-lived resources. Each request gets a cheap
`Scope` through `AsyncLocalStorage`; it lazily reuses Actor, Facades, Services,
and request-local `Facts`. A Service that writes a fact must update or
invalidate its own request-local cache.

Client dependencies flow from React through Interact:

```text
component → hook → client/interact → client/api and/or client/data
```

`client/data` contains IndexedDB mechanisms. `client/interact` owns local versus
remote selection, normalization, consistency, proposals, reconnect recovery,
retention, and quota. React must not import raw client data or invent its own
online/offline policy. Zustand is a presentation projection, not another
persistence layer.

Production boot is a separate correctness chain:

```text
launcher/launcher.js → server.js → server/main.mjs
stable shell.html → active monolithic bundle in IndexedDB
```

The launcher alone owns installed versions, the active pointer, update
confirmation, rollback, and Windows compatibility. The application stages and
installs its client bundle through the Shell/Service Worker protocol.

The full engineering guide is in [docs/README.md](./docs/README.md).

## Repository map

```text
client/          browser-only React application
  api/           typed OneShot facade and raw HTTP clients
  components/    presentation and interaction
  hooks/         React adapters
  data/          raw IndexedDB representation and transactions
  interact/      browser business logic, sync, recovery, quota
  runtime/       application bundle update manager
  store/         Zustand presentation state
server/          Node.js application runtime
  actions/       OneShot request adapters
  data/          all SQLite primitives
  domain/facade/ public actor-dependent business API
  http/routes/   uploads, downloads, rendering, discovery
  infra/         DB, files, configuration, update plumbing
  protocol/      WebSocket connection/protocol implementation
  runtime/       Runtime, Scope, Actor, Facts, UnitOfWork
  services/      domain mechanisms and side effects
  validation/    semantic validation
shared/          wire schemas, shared types, pure cross-runtime logic
shell/           stable production bootstrap document and worker
launcher/        version/process/update/rollback owner
scripts/         build, development, operation, and system tests
docs/            engineering design memory and system guides
```

## Development

Prerequisites are Node.js 22 x64, npm, Git submodules, a Rust nightly with
`rust-src`, and `wasm-pack`. The build also uses ordinary Linux packaging tools
such as `zip`; release assembly currently runs on Linux x64.

Infini is pinned as a Git submodule and rebuilt for WebAssembly MVP features so
it works in Chrome 70 without experimental flags:

```bash
git submodule update --init --recursive
rustup toolchain install nightly-2026-05-10 --component rust-src
cargo install wasm-pack
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Vite proxies WebSocket and
HTTP application traffic to the development server on port 3001. The initial
development administrator PIN is `123456`; it is a development bootstrap value,
not a production credential.

Useful commands:

| Command                      | Purpose                                                   |
| ---------------------------- | --------------------------------------------------------- |
| `npm run lint`               | build native/Wasm prerequisites, type-check, and lint     |
| `npm run format`             | format the working tree with Prettier                     |
| `npm run test:e2e`           | build and exercise the fixed Chrome 70 HTTPS/offline path |
| `npm run test:manual`        | build and start the current manual system harness         |
| `npm run test:manual-legacy` | run the legacy-browser manual harness                     |
| `npm run reset`              | reset development data; this is destructive               |
| `npm run https:check`        | validate configured deployment certificates               |
| `npm run https:renew`        | renew certificates through the configured DNS flow        |
| `npm run pdfrender:update`   | fetch and verify supported native renderers               |

The package currently has no unit-test runner for scattered `*.test.ts` files.
Type-checking those files is not evidence that their assertions ran. New tests
belong in the owned system/invariant harness until a deliberate unit-test
architecture is introduced.

## Production builds

Build one amd64 deployment target at a time:

```bash
npm run build -- linux-redhat
npm run build -- linux-debian
npm run build -- windows
```

Artifacts are written to `build/bootstrap-<target>.zip` and
`build/deploy-<target>.zip`. Intermediate output is kept under `.cache/` unless
`CLASSAPP_BUILD_CACHE` selects another location. Deployment secrets under
`worktree/secrets/` are ignored by Git; AI configuration is optional, while a
build with `CLASSAPP_REQUIRE_HTTPS=1` requires valid HTTPS material.

The fixed-browser E2E path additionally expects the controlled Chrome package
and certificates described by the test harness. A successful Vite session in a
modern browser does not validate the production Shell, Service Worker,
IndexedDB activation, offline restart, or Chrome 70 compatibility.

## Documentation

Start with:

1. [Product context and design philosophy](./docs/product-context.md)
2. [Current architecture](./docs/architecture.md)
3. [AI-agent change method](./docs/engineering/agent-method.md)
4. [Known traps and rejected patterns](./docs/engineering/traps.md)

The documentation index then routes to offline architecture, lifetime/ownership,
authority, validation, Incidents, AI, billing, updates, document rendering,
security, privacy, operations, UI state, and domain-specific flows. Historical
root `ARCHITECTURE.md` and older rewrite notes may explain intent, but they do
do not override the engineering guide, verified current code, or current
product premise.

## License

The main project is licensed under the
[Apache License 2.0](./LICENSE), except for `public/stickers`. Bundled third-party
source and native components remain subject to their respective licenses.
