# Frontend state and UI boundaries

The browser is not a thin view over HTTP. It is an offline-capable projection
engine running on Chrome 70–80, with IndexedDB persistence, reconnect repair,
local proposals, large readers, and ephemeral React interaction. Correctness
depends on giving each kind of state exactly one owner.

## State taxonomy

| State                          | Owner                                              | Examples                                                    |
| ------------------------------ | -------------------------------------------------- | ----------------------------------------------------------- |
| durable local domain           | `client/data` representation, governed by Interact | entities, access, coverage, proposals, retention            |
| remote/local orchestration     | `client/interact`                                  | normalization, merge, recovery, quota, subscriptions        |
| shared presentation projection | Zustand store                                      | selected directory snapshot, session view, transient status |
| component interaction          | hook/component                                     | open menu, draft input buffer, focus, measurement           |
| server truth                   | server domain/data                                 | authority, canonical content, revisions, billing            |

Zustand is not a second durable database. React components and hooks must not
import raw `client/data` or choose online versus offline themselves. Interact
exposes a stable use case/resource API and owns the decision.

## Required dependency direction

```text
component → hook/presentation adapter → interact use case/resource
                                      → client/repo consistency model
                                      → client API and/or client data
                                      → EventBus/recovery/retention mechanisms
```

Imports that reverse this direction create hidden policy. A component may
request “open conversation” or “retain article”; it may not manually read an
IndexedDB store, race it against an HTTP call, then patch Zustand.

## Resource contract

A resource should make these states distinguishable:

- usable local value;
- refreshing remote value;
- confirmed absence or denied access;
- offline without adequate local coverage;
- checked business error;
- contained unexpected failure with Incident ID.

Do not collapse them into `data | null` plus a generic loading boolean. Stale
data may remain useful during refresh, but the UI must not present a partial
page as proof of complete coverage.

Resource identity must be stable for the logical key and actor. Mutable
`lastUsed` or listener counts must not participate in identity. Subscribe and
unsubscribe symmetrically; detached async failures go through client Incident
capture instead of unhandled promises or ad hoc `console.error`.

## Session and actor transitions

Login, restore, unlock, logout, expiration, and reconnect are one session state
machine. Capture the actor/session generation at the start of async work. Before
publishing its result, prove the generation is still current.

```text
publish(result) ⇒ result.actor = currentActor ∧ result.sessionGen = currentGen
```

On actor change, detach EventBus listeners, invalidate actor-bound resources,
clear presentation projections, and reopen the correct IndexedDB ownership
context. Cleanup failures may be reported independently but must not prevent
the security-critical in-memory detach.

## Optimistic and offline intent

Only state with a declared merge algebra may be written optimistically. The UI
emits intent; Interact records a proposal and arbitrates responses/events.

- assignment: compare proposal generation/version;
- watermark: merge with `max`;
- server-only transition: show pending UI but do not invent durable truth;
- append/create: use a stable idempotency identity if retries are permitted.

An old response must never erase newer local intent. A successful network call
does not permit deleting a proposal until the local authoritative write and
acknowledgement condition are satisfied.

## Rendering under Chrome 70–80

- Verify syntax, JavaScript APIs, CSS, WebAssembly, workers, and third-party
  transitive code against the fixed browser, not only Browserslist output.
- Prefer capability checks and explicit fallbacks where the product needs both
  paths. Do not assume a modern polyfill can reproduce browser primitives such
  as streams, module workers, or PDF rendering reliably.
- Large monolithic application bundles are acceptable because stable Shell
  activation and offline availability dominate initial download latency.
- Avoid PDF.js. The supported architecture consumes server-rendered document
  bundles through the offline binary pipeline.
- Store binary payloads in the representation required by the local model;
  IndexedDB `Blob` behavior on target Chrome is not assumed portable.

## Lists, readers, and memory

Bidirectional infinite readers need stable identity, deterministic ordering,
coverage intervals, anchor preservation, and bounded mounted DOM. Do not use
array index as identity or infer exhaustion from a short cache page. Follow the
dedicated infinite-scrolling contract.

Object URLs, observers, timers, subscriptions, workers, and decoded document
assets are operation/component resources. Release them deterministically.
Virtualization is a memory correctness mechanism on managed old browsers, not
merely a performance enhancement.

## UI policy

The UI may explain domain choices but must not become their owner. Administrative
screens collect and validate one operation intent, call a narrow API, and render
the returned outcome. Cross-row `Promise.all` is not an atomic batch. If the
product says “all targets changed,” implement one Facade/Service transaction
and one safe audit result.

Error messages distinguish user-correctable validation, permission/state
conflict, offline inadequacy, and Incident failure. Never catch every error and
show “offline”; that hides corruption and programming errors.

## Review checklist

1. Which state class is introduced, and is there already an owner?
2. Can two actors or two resource keys observe the same mutable handle?
3. Can a late request/event overwrite a newer proposal or session?
4. Is coverage proven before offline data is presented as complete?
5. Are subscriptions, object URLs, and background work disposed?
6. Does the production Shell bundle run in fixed Chrome, including offline?
7. Are accessibility, keyboard operation, narrow screens, and Chinese content
   checked without moving business policy into the component?
