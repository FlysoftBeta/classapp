# Build, startup, deployment, and rollback

The update system is one contract spanning build scripts, version directories,
launcher, server, SQLite backup, Shell, Service Worker, and client bundle. A
local edit to one stage can break boot or rollback several processes later.

## Build identity

One build ID identifies:

- launcher/server deployment content;
- runtime manifest;
- stable Shell asset for that release;
- monolithic client bundle;
- Service Worker active-Shell metadata;
- Incident/source-map namespace.

Never generate separate independent version IDs for these artifacts.

## Release artifacts

The build targets `linux-debian`, `linux-redhat`, or `windows`. Assembly
runs on Linux x64 for every target; GitHub Actions currently hosts that
path only for Windows. A release produces:

- bootstrap archive for first installation;
- deploy archive for an existing launcher;
- selected platform native Node/runtime dependencies;
- exactly the compatible Poppler renderer package;
- production `models.json` and HTTPS deployment material when configured;
- immutable bundle/Shell files and source maps.

The host needs only the packaged runtime contract; it does not run npm or fetch
dependencies. Intermediates live in `.cache`; `build/` contains final archives
and must support several targets coexisting.

Windows constraints apply to `launcher.ts` and emitted CommonJS: no shebang,
no Unix-only rename/process assumptions, correct path handling, and compatible
child lifecycle.

## Process boot

```text
launcher.js
  → owns installation root and PID
  → selects current/
  → forks current/server.js
  → sends immutable RuntimeConfig over IPC
  → server.js installs config and imports server/main.mjs
  → main creates Coordinator, Executor pool (workers load sibling executor.mjs),
    UpdateRuntime on the Coordinator, maintenance, listeners
  → Executor Action jobs that need update status/install/confirm/rollback RPC
    to Coordinator sticky occupancy
  → graceful shutdown closes protocol/listeners/tasks
```

`server.js` and launcher are process adapters. Business logic does not belong
there. Runtime configuration includes explicit app/data roots, build ID, ports,
platform renderer paths, HTTPS material, update directories, and proxy policy.
`UpdateRuntime` is Coordinator sticky occupancy: launcher still sends `update`
directories in the boot payload, and development omits them so that occupancy
is not installed. Executor workers receive a clone of `RuntimeConfig` with
`update` stripped so they cannot host a second update occupancy or talk to the
launcher over `process.send`. Why leftover, not a request singleton, owns this
is [occupancy](../foundations/server-occupancy.md).

## Server deployment state machine

```text
idle
  → validate uploaded/cloud archive and manifest
  → replace staging directory
  → create SQLite backup
  → persist pending marker
  → ask launcher to stop child and apply update
  → launcher renames current→backup, staging→current
  → launcher persists DB backup name + original appliedAt
  → start new child and arm remaining-time watchdog
  → pending confirmation
      ├─ confirm: clear backup + pending metadata
      └─ rollback/timeout/crash: restore app + DB and restart
```

Only the launcher owns directory switching and rollback watchdog. The server
reports remaining status and asks for confirm/rollback; it does not start a
second rollback timer. `appliedAt` must survive launcher restart so the
confirmation window does not reset. The DB backup identity must survive so
rollback restores schema and application as a pair.

## Validation before switch

- archive extraction rejects traversal, duplicates, unexpected structure, and
  unsafe sizes;
- cloud manifest and every part have bounded size and SHA-256;
- reconstructed archive size/hash match;
- staged deployment contains required runtime/build files;
- target/platform compatibility is explicit;
- database backup completes before requesting switch;
- cleanup failure preserves the validation error;
- an earlier pending update blocks another deployment.

The current UpdateRuntime buffers the full cloud archive in memory after buffering
parts. This is acceptable only under the configured bounds and available host
memory; a future large-release change should stream to a staged file with
incremental aggregate hashing, not merely increase limits.

## Browser update versus server update

Server deployment and browser asset activation are related by build ID but have
different owners:

- server `UpdateRuntime` validates/stages a deployment on the Coordinator;
- launcher applies/rolls back version and DB;
- running client `BundleManager` discovers the active server build's manifest;
- IndexedDB pointer activates bundle;
- Service Worker pointer activates matching Shell.

The browser must not keep making business requests from a mixed Shell/bundle
release after activation. Stage both, compensate partial pointer activation,
then reload.

## Cloud update

Cloud polling is process-bound and optional. It has one initial delayed check
and bounded interval, never checks while installing/pending, records the latest
manifest/status, and captures contained failures without stopping the server.
Automatic check does not imply automatic install unless product policy says so.

URLs and redirects are security-sensitive. A production hardening change should
define allowed protocols/hosts, DNS rebinding/SSRF policy, redirect validation,
and signature provenance in addition to transport hashes. SHA-256 proves bytes
match the manifest, not who authored the manifest.

## Verification

- fresh bootstrap on every target;
- normal update and explicit confirm;
- explicit rollback and watchdog timeout;
- child crash before/after ready;
- launcher restart while pending (timer does not reset);
- app rollback with DB backup restoration/WAL cleanup;
- invalid/truncated/path-traversal/wrong-platform archive;
- cloud part retry/hash/size/manifest errors;
- browser mixed-activation compensation;
- Windows path/process behavior;
- Chrome 70 old Shell → new Shell/app schema cutover.
