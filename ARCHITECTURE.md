# ClassApp runtime architecture

ClassApp is a React single-page application with a custom Node.js runtime. It
does not use Next.js.

## Production boot

```text
launcher/launcher.js -> server.js -> server/main.mjs
                                      |-- HTTP shell/resources
                                      `-- WebSocket /ws
```

The launcher still owns application-directory switching, dependency refresh,
database backup, update confirmation, and rollback. It injects the runtime
configuration into `server.js` over IPC. The server bundle is produced by Vite
and keeps native/runtime dependencies external.

Every release has exactly one build id shared by launcher, server, Shell,
Service Worker and client bundle. `/app/manifest.json` describes the Shell and
bundle belonging to that build. `shell.html` only performs the first bundle
installation. After startup, `BundleManager` owns every check, download, stage
and activation operation for both assets. The Service Worker never discovers
updates independently: it stores the Shell selected by `BundleManager` and
remembers that Shell's build id.

Update ownership is deliberately singular:

| Concern                                                  | Owner                            |
| -------------------------------------------------------- | -------------------------------- |
| release build id and runtime asset paths                 | runtime config / `runtimeAssets` |
| post-bootstrap browser checks and asset download         | `BundleManager`                  |
| active bundle pointer                                    | IndexedDB `globals`              |
| active Shell pointer and cached Shell                    | Service Worker Cache Storage     |
| deployment validation and staging                        | server `UpdateManager`           |
| directory swap, confirmation timeout and app/DB rollback | launcher                         |

The launcher persists the database backup name and the original apply time in
`.pending-update.json`. Restarting the launcher therefore neither loses the DB
rollback target nor resets the confirmation window. The server reports status
but does not run a second rollback timer.

The production browser build is one ESM file. All application CSS is imported
as text and injected by the entrypoint, so there is no separate CSS artifact.

## Client runtime

- `client/data` is the mechanism layer: short-lived IndexedDB leases, normalized
  objective/actor stores, extent files, and atomic transaction primitives.
- `client/interact` is the policy layer: typed remote calls, local-first reads,
  proposal arbitration, reconnect recovery, coverage tracking and quota eviction.
- React consumes `interact` use cases and presentation state. It does not choose
  between online and offline sources or write IndexedDB directly.
- WebSocket events are queued during reconnect. Recovery refreshes access,
  flushes proposals, catches up revisions, publishes snapshots, and only then
  replays the queued events.
- Binary articles use `ArrayBuffer` extents. Published downloads are
  generation-based; the browser consumes server-rendered document bundles
  through the offline binary pipeline.

The complete client model and its invariants are maintained in
[docs/offline/README.md](./docs/offline/README.md).

The authoritative server entity schema is maintained in
[docs/foundations/server-data-model.md](./docs/foundations/server-data-model.md).

## Server runtime

Every OneShot request passes through two Zod validation layers: the versioned
wire envelope and the registered Action argument schema. Request context
(session token and source IP) is propagated with `AsyncLocalStorage`; Actor,
Service, and Data code remains transport-independent.

Large multipart uploads, blob downloads, PDF rendering, deployment uploads,
and backup downloads remain HTTP routes because they require streaming or raw
HTTP response semantics. Business calls use WebSocket Actions.

User removal has two explicit service use cases. Deactivation revokes account
credentials, asks `GroupService` to remove memberships, and records the stable
identity in `deleted_users`; all other service data remains intact. Purge asks
every owning Service to remove its own user data and side effects before the
identity row is physically deleted. See
[docs/foundations/privacy-and-data-lifecycle.md](./docs/foundations/privacy-and-data-lifecycle.md).

## Development

```sh
npm run dev
```

The development entrypoint starts the backend on port 3001 and Vite on port 3000. Vite serves `index.html` and `client/main.tsx` directly with React Fast
Refresh, completely bypassing `shell.html` and IndexedDB bundle installation.
Repository-local runtime state is kept below the ignored `worktree/` directory:
development data uses `worktree/data/`, reset uses `worktree/prod.db`, and local
HTTPS credentials use `worktree/secrets/`. Script paths are resolved from the
repository location, so npm commands do not depend on the caller's working
directory.

```sh
npm run lint
npm run build -- linux-redhat
```

`npm run build -- <target>` requires one of `linux-redhat`, `linux-debian`, or
`windows`. It creates `build/bootstrap-<target>.zip` for a first install and
`build/deploy-<target>.zip` for the existing update workflow.

Both archives are self-contained at runtime: each version includes only the
selected platform's PDF renderer and native Node binaries. The deployment host
only needs Node.js 22 x64; it never runs npm or downloads dependencies. Runtime
intermediates (`dist`, unpacked deployment, native runtime and downloaded
renderer artifacts) live under `.cache`. Set `CLASSAPP_BUILD_CACHE` to move that
cache elsewhere. `build/` is not cleared and contains only final target archives,
so builds for multiple targets can coexist.

The committed PDF renderer binaries are refreshed manually from the newest
successful `FlysoftBeta/pdf-render` Actions run:

```sh
npm run pdfrender:update
# Reproduce a particular successful run:
npm run pdfrender:update -- --run 31302506864
```

The updater uses authenticated `gh run download`, records GitHub's artifact
digests, hashes and caches the extracted archives, validates all three platform
archives, and atomically replaces `lib/poppler-prebuilt`. Release builds never
contact GitHub.
