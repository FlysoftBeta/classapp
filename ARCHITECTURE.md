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

`shell.html` is intentionally stable and receives a one-year HTTP cache policy.
It opens the `classapp-runtime` IndexedDB database, loads the active application
bundle, and only downloads `/app/app.js` when no installed bundle is usable.
The application itself checks `/app/manifest.json`, installs a newer bundle in
IndexedDB, and reloads so the Shell can activate it.

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
