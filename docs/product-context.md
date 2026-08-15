# Product context and design philosophy

## The premise

ClassApp serves a small school community over a concealed intranet. Browser
clients include old managed tablets and embedded WebViews in the Chrome 70–80
range. The network is intermittent, the server may be unavailable while a user
is reading, and administrators need to operate the deployment without a mature
cloud platform around it.

This premise is architectural input, not incidental deployment detail. A change
that works in current Chrome on a developer laptop but fails in the target
browser, insecure-to-secure upgrade path, or offline restart is not complete.

## Optimize for the actual bottleneck

ClassApp does not optimize for public-Web first paint, global scale, multiple
database readers, or independent team deployment. It optimizes for:

- reliable entry into the application after the server disappears;
- compatibility with a fixed old browser;
- bounded client memory and IndexedDB behavior;
- explicit recovery after missed WebSocket events;
- simple operations on a single Node.js/SQLite deployment;
- moderation and client admission appropriate to a managed school environment;
- preserving user decisions made while disconnected;
- deployability and rollback without a host-side package installation step.

A giant ESM client bundle is therefore acceptable. Loading speed is secondary,
and a single artifact is easier for the thin Shell to install and activate
atomically. By contrast, introducing PDF.js is unacceptable unless it is proven
on the target Chrome and integrated with offline storage; its conventionality
does not compensate for being unusable in production.

Similarly, SQLite's single-writer model is not a problem at this scale. Adding
a distributed database, event broker, or multi-reader architecture would add
failure modes without addressing a measured constraint.

## Constraint-derived choices

| Constraint                 | Consequence                                                                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chrome 70–80               | ES2017 output plus explicit polyfills; avoid new browser APIs unless transformed or proven; ArrayBuffer instead of persisted Blob; real legacy-browser E2E. |
| Intermittent intranet      | Local-first reads, explicit partial coverage, persistent proposals, revision recovery, queued events, retained content.                                     |
| Offline application entry  | Stable `shell.html`, Service Worker navigation cache, monolithic bundle in IndexedDB, independently owned Shell/app schemas.                                |
| PDF engine incompatibility | Render once on the server with bundled Poppler; deliver immutable HTML/SVG/WebP resources progressively; sandbox rendering.                                 |
| Managed shared devices     | Client identity and whitelist/binding are part of authentication, not merely analytics. One WebSocket may bind multiple immutable actors.                   |
| Multiple LAN ports         | The same HTTP routes and WebSocket contract are mounted on each listener; resource fetches may spread across origins.                                       |
| Small community            | Direct business rules in Facades are clearer than a general capability DSL; roles reflect responsibilities rather than tenant-configurable policy.          |
| Self-hosted updates        | One build identity spans launcher, server, Shell, Service Worker, and bundle; staging, activation, confirmation, and rollback have singular owners.         |

The installed production application is expected to run in a Secure Context
after the HTTPS bootstrap/upgrade path. The old browser target does not mean the
application must avoid secure-context APIs that Chrome 70 actually supports; it
means support must be verified in that browser and in the real boot path.

Compatibility is existing project infrastructure, not something each feature
should rebuild independently. Reuse the current transpilation and `core-js`
polyfill path, established CSS fallbacks, Wasm MVP build constraints, binary
storage representation, capability checks, and fixed-browser E2E. A polyfill is
appropriate for a compatible language/library surface; it is not proof that a
missing browser primitive such as a stream, worker mode, or PDF engine can be
faithfully reproduced.

## Design principles

### Separation of mechanism and policy

Mechanisms expose what can be done safely; policy decides what should be done
for this actor and circumstance.

- `client/data` knows IndexedDB transactions, normalized rows, extents, and
  atomic publication. `client/interact` decides remote versus local behavior,
  merge policy, recovery, and eviction order.
- server Data knows SQL and row mapping. Services know domain mechanisms.
  Facades know which actor-dependent path is legitimate.
- the Service Worker can stage and activate a Shell chosen by the application;
  it does not independently discover application versions.

Policy must not leak downward as convenience flags such as `isAdmin`, `online`,
or `force` unless that value describes an objective mechanism rather than an
authorization bypass.

### Singular ownership

Every stateful concern needs one authoritative owner:

- process resources: `Runtime`;
- one request's reusable graph: `Scope`;
- request-local knowledge: the owning Service's `Facts`;
- transaction nesting and post-commit effects: `UnitOfWork`;
- actor authorization: public Facade entry points;
- SQL and row representation: Data;
- WebSocket lifecycle: transport;
- authentication bindings: remote session/protocol session;
- offline policy: `client/interact`;
- raw local persistence: `client/data`;
- active application bundle: the Shell IndexedDB pointer;
- active cached Shell: the Service Worker metadata pointer;
- directory swap and rollback watchdog: launcher.

Duplicating ownership creates two authorities that can disagree. Most subtle
bugs in this class of system are not missing code but competing truths.

### Explicit partial knowledge

The browser does not contain a replica of the server. It contains a disposable,
partial projection plus irreplaceable local decisions. A list of rows proves
nothing about omitted rows. Coverage metadata must state which interval or
snapshot has been authoritatively observed.

An event is a latency optimization, not a durable log. Snapshots and revision
protocols repair missed events. A cache failure must not convert a valid online
response into an online outage.

### State machines over flags

Complex workflows should expose states and legal transitions. Examples include:

- reconnect: disconnected → authenticate → access refresh → proposal flush →
  revision recovery → snapshot refresh → event replay → live;
- file publication: staging → complete/published → retired → reclaimed;
- server update: validate → stage → back up → switch → pending confirmation →
  confirmed or rolled back;
- AI run: planned → reserved → running/streaming → settled or failed/cancelled.

Several booleans with implicit combinations are harder to reason about and
usually admit impossible states.

### Make proofs travel with data

Store or transmit the information needed to establish correctness:

- cursor tuple includes both sort value and stable ID;
- Post includes immutable identity, sequence, and current revision;
- actor projections name the actor;
- remote operations capture actor and credential epochs;
- bundle resources have content IDs, stored/raw sizes, encodings, and hashes;
- update parts and aggregate archive have sizes and SHA-256 digests;
- user proposals have operation IDs and ordering stamps;
- incidents carry build and environment identity.

Do not infer a proof later from row count, arrival order, mutable handles, or UI
state.

### Reconstructible versus irreplaceable state

Reconstructible state may be destroyed at a hard compatibility boundary:
objective client entities, server-derived access projections, coverage, and
downloaded bodies. Irreplaceable state must survive routine recovery: pending
user proposals, user-authored AI workspace files, server database state,
secrets, and rollback metadata.

This distinction determines migration, backup, quota, and repair behavior. It
is more useful than the vague labels “cache” and “data.”

## Non-goals

Unless the product premise changes, do not optimize for:

- arbitrary browsers or browser extensions;
- Internet-scale concurrency or horizontal server scaling;
- pluggable tenant-defined authorization languages;
- microservices or distributed transactions;
- client-side execution of PDFs or office document engines;
- exhaustive backwards compatibility for reconstructible IndexedDB schemas;
- speculative abstraction for hypothetical content providers;
- offline creation of server-established facts such as group membership, DMs,
  or published posts.

Non-goals are not permanent prohibitions. Changing one requires documenting the
new premise and re-evaluating all affected invariants first.
