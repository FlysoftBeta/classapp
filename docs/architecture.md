# Current system architecture

## Runtime topology

ClassApp is a React single-page application with a custom Node.js runtime. It
does not use Next.js.

```text
Production host
  launcher.js
    └─ current/server.js
         └─ server/main.mjs
              ├─ SQLite database and process Runtime
              ├─ HTTP/HTTPS listeners on configured LAN ports
              │    ├─ stable Shell and application artifacts
              │    ├─ Service Worker
              │    └─ raw streaming/multipart routes
              └─ WebSocket /ws
                   ├─ versioned frames and Action registry
                   ├─ multiple authenticated actor bindings
                   └─ domain events

Browser
  Service Worker navigation cache
    └─ shell.html
         └─ active monolithic ESM bundle from IndexedDB
              ├─ React presentation
              ├─ client/interact policy and orchestration
              ├─ client/data IndexedDB mechanisms
              └─ one WebSocket transport
```

Development starts `server/dev.ts` and Vite separately. It deliberately bypasses
the production Shell and IndexedDB bundle loader to preserve fast refresh. A
production-path change is therefore not verified by development mode alone.

## Repository boundaries

```text
client/
  api/          narrow typed Action/raw-HTTP adapters
  components/   rendering and user interaction
  hooks/        presentation lifecycle adapters
  interact/     client business policy, synchronization, recovery
  data/         raw IndexedDB mechanisms and normalized persistence
  lib/          pure browser algorithms, bundle parsing, virtualization support

server/
  protocol/     WebSocket frames, sessions, dispatch, result encoding
  actions/      validated wire-to-Facade adapters
  http/routes/  streaming, multipart, Range, and download adapters only
  domain/facade public business entry points and actor-dependent path selection
  services/     coherent domain/operational mechanisms
  data/         SQL and database row mapping
  runtime/      process/request lifetimes, Actor, Facts, UnitOfWork, composition
  infra/        filesystem, database bootstrap, render/update/runtime mechanisms
  validation/   semantic validation shared by server entry paths

shared/         wire schemas, semantic DTOs, pure cross-runtime logic
launcher/       version switching, child process lifecycle, rollback watchdog
scripts/        build, deployment, certificates, and production test harness
shell.html      stable ES5-style production bootstrap document
lib/            vendored/submodule native and browser mechanisms
```

## Server request path

The default business path is:

```text
WebSocket frame
  → frame schema
  → Action name + argument schema
  → Action adapter
  → public Facade
  → one or more Services
  → Data
  → output schema
  → result/incident envelope
```

Raw HTTP is reserved for semantics that WebSocket Actions cannot express well:
multipart uploads, byte/range streams, large framed resource streams, and
downloads. An HTTP route still enters a request `Scope` and calls a Facade for
authorization/business selection. HTTP status codes are transport outcomes,
not the domain error model.

### Directional dependency rule

```text
protocol/http → actions → facades → services → data
runtime -------------------↑         ↓
infra supplies process/filesystem mechanisms where explicitly injected
```

Actions must not import Data or construct Services. Facades must not contain
SQL. Services must not infer the caller's administrative authority. Data must
not publish events or choose actor policy.

The current code has exceptions, such as incident-key SQL in
`IncidentService`, singleton access to `UpdateManager`, and some Service-level
event publication outside a Scope `UnitOfWork`. These are migration defects,
not precedents.

## Client request path

```text
component/hook
  → interact use case
     ├─ emit a local projection when useful
     ├─ consult connection and coverage state
     ├─ make a typed Action or raw streaming request
     ├─ normalize objective / actor / decision fields
     ├─ merge transactionally into IndexedDB
     └─ publish a presentation DTO
```

React expresses intent and presentation state. It does not decide whether the
operation is online, infer cache completeness, compare revisions, or write raw
IndexedDB. Zustand may hold rebuildable view projections and ephemeral UI state;
it is not a second persistent cache.

`client/api` is a narrow protocol adapter, not another business layer. New
components should normally call `client/interact`, not `client/api` directly.

## Shared contracts

`shared/protocol/actions.ts` and event schemas are the correlation point between
client and server. The server validates Action arguments and outputs. The client
validates result and event payloads. Internal database representations do not
cross this boundary: feature bitsets become semantic booleans, rows become
domain DTOs, and SQL-only paths remain private.

Protocol types should describe semantic operations. `override` versus
`furthest`, for example, is part of the command; the server must not guess it
from whether the client seems online.

## Data topology

The authoritative server database is SQLite schema v22 in the examined working
tree, with v17 as the accepted migration baseline. The browser uses the shared
`classapp-runtime` IndexedDB database but has two independent schema owners:

- Shell: `shell_bundles`, `shell_kv`, Shell schema marker;
- application: domain stores, extents, globals, application schema marker.

Physical IndexedDB versions coordinate upgrades but carry no semantic schema
meaning. Either owner may win a version race; each must reopen and verify its
own marker. Reconstructible application stores are nuked at a yanked schema
boundary while Shell stores remain bootable.

## Event model

Server events share the WebSocket transport. A process-bound event bus maps
domain channels to protocol sessions. Services publish complete authoritative
rows or invalidation hints; clients persist global data before presentation
subscribers consume it.

Events are neither a database nor a guaranteed queue. Re-authentication refreshes
the server-side channel set. Reconnect recovery must complete access refresh,
proposal flushing, revision catch-up, and snapshot refresh before queued events
are replayed.

## Architectural evaluation rule

When deciding whether code belongs in a layer, ask:

1. Is this transport representation, public actor policy, objective domain
   mechanism, persistence representation, client orchestration, or rendering?
2. What lifetime owns its mutable state?
3. What fact is authoritative, and can another layer disagree with it?
4. What transaction or publication boundary makes the result visible?
5. How is the result repaired after disconnect, restart, abort, or partial
   download?

File names are secondary. A module called `Service` can still be infrastructure;
a helper inside a component can still be hidden business policy.
