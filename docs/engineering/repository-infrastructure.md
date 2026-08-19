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
- `build-cache.mjs` owns the configurable intermediate cache location.

Release assembly currently runs on Linux x64 and accepts `linux-redhat`,
`linux-debian`, or `windows`. Final archives are written to `build/`; disposable
intermediates live below `.cache/` or `CLASSAPP_BUILD_CACHE`.

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

The executable test surface is owned by `scripts/tests/`. Node's `node:test`
runner is invoked by `scripts/tests/run.mts`:

- `harness/` starts isolated temp data roots, in-memory quota schemas, and a
  thin WebSocket protocol client that does not use the application client;
- `unit/<module>/` holds pure-logic and in-process mechanism tests, classified
  by module (runtime, quota, incidents, storage, consistency, …);
- `smoke/` starts one isolated HTTP+WebSocket development server and calls
  Actions directly;
- `test-e2e.mts` exercises the fixed Chrome 70 production HTTPS, install,
  offline restart, and reconnect path;
- `test-manual.mts` starts the current manual production harness;
- `test-manual-legacy.mts` and `legacy-chrome.mts` support legacy-browser
  inspection;
- `prod-runtime.mts` provides controlled production-runtime test support.

Unit tests run in-process. Smoke tests run sequentially with
`CLASSAPP_EXECUTORS=1` because `setRuntimeConfig` and `env.ts` are
process-global. Each smoke process uses a temporary data root, never
`worktree/data`. Development executor workers load TypeScript through
`server/runtime/executorWorker.dev.mjs` rather than inheriting `node --test`
execArgv.

Use `.cache/` or a directly executed shell/TypeScript probe for temporary
investigation. Temporary migration SQL experiments, Zod shape checks, and
one-off state inspections are probes, not permanent tests. Delete them when
the investigation ends. A test intended to remain must live under
`scripts/tests/unit/` or `scripts/tests/smoke/` and document what invariant it
can falsify. Do not add a co-located `*.test.ts` beside domain source.

## Command meanings

| Command                      | What it currently proves                                 |
| ---------------------------- | -------------------------------------------------------- |
| `npm run lint`               | prerequisites build, TypeScript checking, and ESLint     |
| `npm run build -- <target>`  | one target can be assembled into release archives        |
| `npm run test:unit`          | unit/property tests for server and shared invariants     |
| `npm run test:smoke`         | isolated server API smoke tests, no application client   |
| `npm run test`               | unit then smoke                                          |
| `npm run test:e2e`           | the configured fixed-browser production/offline scenario |
| `npm run test:manual`        | a human can inspect the current production harness       |
| `npm run test:manual-legacy` | a human can inspect the legacy-browser harness           |
| `npm run https:check`        | configured certificate material passes script checks     |
| `npm run pdfrender:update`   | remote renderer artifacts can be fetched and verified    |
| `npm run media:update`       | media manifest is refreshed and POT server cache rebuilt |

These commands are not interchangeable. `npm run build` is not needed merely
to typecheck; `npm run lint` does not execute tests; Vite does not
exercise Shell activation; a manual harness is not an automated assertion.

## Extending the infrastructure

Before adding a script, decide whether it is development, build, operation, or
test infrastructure. Give it one owner, bounded paths, non-interactive failure
semantics where practical, and an explicit package command only when it is a
supported entry point. Reuse `scripts/paths.mjs`, existing cache/worktree
locations, and child-process cleanup patterns.

A script must not silently download or mutate deployment state as a side effect
of typechecking. Network/native preparation belongs in an explicitly named
build or operation phase, even if a package lifecycle hook invokes it today.
