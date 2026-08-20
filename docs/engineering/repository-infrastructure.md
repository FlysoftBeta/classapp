# Repository, scripts, and test infrastructure

This document describes the current development machinery. It is a map, not a
promise that every script or directory must remain forever. When the machinery
changes, update this document and the short orientation in root `AGENTS.md` in
the same change.

## Source and generated areas

```text
client/       browser application
server/       Node runtime and business backend
shared/       cross-runtime types, wire schemas, and pure logic
shell/        stable production bootstrap and Service Worker
launcher/     process, version, activation, and rollback control
scripts/      build, development, operation, and system-test entry points
lib/          pinned or bundled native/Wasm dependencies
docs/         engineering design memory
worktree/     ignored local runtime state and secrets
.cache/       reconstructible build output and temporary engineering probes
build/        final target archives
```

Do not place durable source or the only copy of a test result in `.cache` or
`worktree`. Do not read real deployment data from a test unless the harness was
explicitly designed and authorized to do so.

## Development orchestration

`npm run dev` first builds the Infini and Zstd WebAssembly prerequisites, then
`scripts/dev/dev.mjs` owns the two child processes:

```text
Vite client :3000 → proxies /ws, /api, /app → Node development server :3001
```

Development intentionally bypasses the production Shell, Service Worker, and
IndexedDB bundle activation path. It is useful for React Fast Refresh but is
not evidence that production boot or offline recovery works.

Development scripts live in `scripts/dev/`:

- `dev.mjs` starts and terminates the paired client/server processes;
- `reset-dev.mjs` resets bounded development state and is destructive;
- `update-pdfrender.mjs` refreshes and verifies the supported native renderer
  artifacts;
- `update-media.mjs` refreshes pinned yt-dlp/plugin URLs and hashes in
  `lib/media/artifacts-manifest.json` and prepares the current platform's POT
  server cache under `.cache/media`.

All repository paths should go through `scripts/paths.mjs` or an existing path
owner rather than depend on the caller's current directory.

## Build infrastructure

`scripts/builds/` owns release assembly and prerequisite compilation:

- `build.mjs` assembles one target release and final bootstrap/deploy archives;
- `build-targets.mjs` is the closed set of supported platform targets;
- `build-media.mjs` verifies and copies pinned media artifacts (yt-dlp, POT
  plugin, the ClassApp music-search extractor plugin, POT server cache) for
  the selected target;
- `runtime-deps.mjs` prepares the pinned native Node runtime/dependencies;
- `build-infini.mjs`, `build-wasm.mjs`, and `build-zstd-web.mjs` build browser
  Wasm compatible with the fixed target;
- `build-cache.mjs` owns the configurable intermediate cache location;
- `katexCss.ts` rewrites the KaTeX stylesheet to woff2 data URLs so the
  production Shell, which fetches only `app.js`, can still typeset math.

Release assembly currently runs on Linux x64 and accepts `linux-redhat`,
`linux-debian`, or `windows`. Final archives are written to `build/`; disposable
intermediates live below `.cache/` or `CLASSAPP_BUILD_CACHE`.

`.github/workflows/build-windows.yml` is the hosted Windows assembly path. It
runs the same Linux x64 assembler, prepares the Windows POT server cache from
the committed media manifest (`npm run media:update -- --prepare-cache
--platform windows`), and uploads `build/bootstrap-windows.zip` and
`build/deploy-windows.zip`. GitHub-hosted archives omit `worktree/secrets/`
HTTPS and AI material. The workflow proves that the Windows target still
packages; it does not exercise a Windows host, launcher rollback, or Chrome 70.

`build-wasm.mjs` keeps the wasm-pack binary cache and cargo home under
`resolveBuildCache()` (`wasm-pack/` and `cargo-home/`). Wasm prerequisite
builds therefore do not write to `~/.cache` or `~/.cargo` and remain usable in
sandboxes that grant workspace writes but mount the user profile read-only.

The Vite configurations have separate ownership:

| Configuration              | Output responsibility                      |
| -------------------------- | ------------------------------------------ |
| `vite.config.ts`           | browser application and development server |
| `vite.server.config.ts`    | Coordinator `main.mjs` and Executor `executor.mjs` |
| `vite.bootstrap.config.ts` | stable bootstrap/server entry artifacts    |
| `vite.launcher.config.ts`  | launcher runtime                           |

Do not infer production behavior from the browser Vite configuration alone.
Build ID, source-map custody, renderer selection, secrets copying, Shell assets,
and launcher packaging are completed by the build scripts.

## Operation scripts

`scripts/operation/` contains narrow operator/build-host workflows rather than
application business logic:

- DuckDNS/ACME certificate inspection and renewal;
- deployment publication to the configured remote.

Secret inputs belong under ignored `worktree/secrets/`. Adding an external
service requires deciding whether configuration is build-host-only,
deployment-copied, or runtime-created. Extend the owning build/runtime config
schema deliberately; never make arbitrary files in `worktree/secrets/`
implicitly available to client code or deployment packages.

## Current test infrastructure

The executable test surface is owned by `scripts/tests/` and runs through
Node's test runner plus the existing production harnesses:

```text
scripts/tests/unit/{client,server,shared}/   pure logic and in-memory SQLite
scripts/tests/smoke/                         live WebSocket Action suites
scripts/tests/test-e2e.mts                   Chrome 70 production path
scripts/tests/test-manual*.mts               packaged manual inspection
```

`npm run test:unit` executes the unit tree. `npm run test:smoke` starts an
isolated development backend and logs in as the root administrator. Seeded
smoke copies a SQLite file into a temporary root and force-resets that
administrator PIN; it never writes the caller's `worktree/data` in place.

Do not add a co-located `*.test.ts` beside production modules. Put the case in
the classified unit or smoke tree so `npm test` actually runs it.

Use `.cache/` or a directly executed probe for temporary investigation, then
delete it. A test intended to remain must live in this owned surface and
document what invariant it can falsify.

## Command meanings

| Command                      | What it currently proves                                 |
| ---------------------------- | -------------------------------------------------------- |
| `npm run lint`               | prerequisites build, TypeScript checking, and ESLint     |
| `npm run test:unit`          | classified pure-logic and in-process SQLite tests        |
| `npm run test:smoke`         | live Action smoke against a fresh isolated database      |
| `npm run test:smoke:seeded`  | live Action smoke against a copied seed database         |
| `npm run build -- <target>`  | one target can be assembled into release archives        |
| `npm run test:e2e`           | the configured fixed-browser production/offline scenario |
| `npm run test:manual`        | a human can inspect the current production harness       |
| `npm run test:manual-legacy` | a human can inspect the legacy-browser harness           |
| `npm run https:check`        | configured certificate material passes script checks     |
| `npm run pdfrender:update`   | remote renderer artifacts can be fetched and verified    |
| `npm run media:update`       | media manifest is refreshed and POT server cache rebuilt |
| `npm run media:update -- --prepare-cache` | `.cache/media` is filled from committed pins without rewriting the manifest |

These commands are not interchangeable. `npm run build` is not needed merely
to typecheck; `npm run lint` does not execute unit or smoke tests; Vite does
not exercise Shell activation; a manual harness is not an automated assertion.

## Extending the infrastructure

Before adding a script, decide whether it is development, build, operation, or
test infrastructure. Give it one owner, bounded paths, non-interactive failure
semantics where practical, and an explicit package command only when it is a
supported entry point. Reuse `scripts/paths.mjs`, existing cache/worktree
locations, and child-process cleanup patterns.

A script must not silently download or mutate deployment state as a side effect
of typechecking. Network/native preparation belongs in an explicitly named
build or operation phase, even if a package lifecycle hook invokes it today.
