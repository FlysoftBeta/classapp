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
| active bundle pointer                                    | IndexedDB `kv`                   |
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

- `RemoteManager` is the concrete WebSocket protocol implementation.
- OneShot calls are statically typed from the Action contract and correlated by
  request id.
- EventBus notifications share the same socket and trigger a full refresh after
  a disconnect, preserving the existing incremental/full-refresh model.
- `ResourceManager` separates evictable cache resources from resources a user
  explicitly persists. It requests persistent browser storage for the latter
  and evicts least-recently-used cache entries before quota pressure becomes
  critical.

The detailed storage schema, merge/retention rules, reconnect flow, known risks,
and change invariants are maintained in [OFFLINE_SYNC.md](./OFFLINE_SYNC.md).

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
identity row is physically deleted. See [USER_LIFECYCLE.md](./USER_LIFECYCLE.md).

## Development

```sh
npm run dev
```

The development entrypoint starts the backend on port 3001 and Vite on port 3000. Vite serves `index.html` and `client/main.tsx` directly with React Fast
Refresh, completely bypassing `shell.html` and IndexedDB bundle installation.

```sh
npm run lint
npm run build
```

`npm run build` creates `build/bootstrap.zip` for a first install and
`build/deploy.zip` for the existing update workflow.

Both archives are self-contained at runtime: each version includes its own
production `node_modules` with native binaries for Linux x64 and Windows x64.
The deployment host only needs Node.js 22 x64; it never runs npm or downloads
dependencies. Native Windows artifacts are fetched and integrity-checked only
while producing the release on Linux.
