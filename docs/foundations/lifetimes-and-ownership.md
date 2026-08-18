# Lifetimes, ownership, and composition

Lifetime is an independent design dimension. A class is not process-bound
because its name says `Service`, and a domain boundary is not determined by how
long an object lives.

## Lifetime lattice

```text
Coordinator
  ├─ protocol sessions, EventBus
  ├─ StickyRuntimes (AI, media, import, teach, upload, storage)
  ├─ Coordinator SQLite connection
  └─ ExecutorPool
       └─ worker: SQLite connection, request Scope
            ├─ immutable RequestIdentity
            ├─ UnitOfWork
            ├─ Actor / AuthorityService
            ├─ Composition
            └─ Facades and Services (request-local, not pooled)
```

operation
  ├─ transaction
  ├─ captured ActorContext / credential epoch
  ├─ idempotency identity
  └─ immutable inputs for work that outlives the request

view/component
  └─ presentation lifecycle only
```

### Coordinator and StickyRuntimes

`Coordinator` is the process composition root. StickyRuntimes own identity-bearing
in-flight work (AI abort controllers, media download slots, import tasks). Each
has an explicit start/reconcile/stop story and must not capture a request `Scope`
or Actor. None of them own a client socket.

The Executor pool runs domain Actions. A worker's leftover after a job is only
SQLite rows plus returned events and sticky commands.

Use Coordinator/Sticky lifetime only when continuity across requests is
semantically required. A global map is not justified merely because constructing
it locally is inconvenient.

### Scope

`Scope` represents exactly one Action (on an Executor) or one short HTTP request
(on the Coordinator for streaming/lease routes). It is propagated with
`AsyncLocalStorage` on that thread only. It owns immutable request identity, one
`UnitOfWork`, and a get-or-init object graph. Two calls for the same Service or
Facade in a request must receive the same instance; different requests must not
share that instance. Service instances are never pooled.

### Isolation

SQL Read Skew is prevented by WAL snapshot transactions on the connection that
owns the work. Do not introduce a request-local Fact cache. After a write
commits, later reads in the same request use a new snapshot or the write's
return value. Mutation transactions re-read authorization and quotas under
`BEGIN IMMEDIATE`.

### Composition

`Composition` is the typed composition root for the request graph. It may wire
collaborators but must not become a service locator used deep in the system.
Actions retrieve a Facade from Composition; Facades receive typed Services;
Services receive Data/infra mechanisms at construction or through narrow
factories.

Adding a dependency requires updating the composition root visibly. Hidden
imports of global database handles, singleton managers, or `currentScope()`
from a Service conceal the true graph and are discouraged.

### Operation

An operation is the smallest unit with one coherent outcome. It may be a
transaction, a durable asynchronous command, a download generation, or an AI
run. If it can outlive its request, capture immutable identifiers and inputs;
never retain Scope, Actor, request Services, or open transactions.

On the client, `ActorContext(userId, authEpoch)` is captured at the public use
case boundary. Every asynchronous helper receives that context or an
actor-bound repository. It must not reread a mutable global active user after
an `await`.

## Occupancy

Three kinds, not “stateless vs stateful” as a class label:

- **Protocol session** — sticks to a client connection.
- **Executor job** — no leftover on the worker after return; at most SQLite rows
  plus returned events/commands.
- **StickyRuntime task** — sticks to a domain job id until a terminal state;
  restart reconciles from SQLite.

See [0001: Coordinator, Executor pool, and StickyRuntimes](../decisions/0001-coordinator-executor.md).

## Ownership rules

- A mutable fact has one owner. Other modules ask the owner; they do not mirror
  it in another cache.
- A background task has one lifecycle owner responsible for cancellation and
  restart reconciliation.
- A lock protects one named resource at the narrowest meaningful granularity.
- A pointer has one authority. Redundant `active` flags are forbidden when an
  active-ID pointer exists.
- Authorization is a Facade decision over Service-owned relationships, re-read
  in the write transaction.
- UI state cannot become the authority for server or offline domain facts.

## Review questions

Before adding state, answer:

- What creates it, and what destroys it?
- Can two requests see the same instance?
- Can an actor switch while an operation is in flight?
- What happens after server restart, browser navigation, or another tab's
  IndexedDB upgrade?
- Who owns the write lock / snapshot after a write?
- Is the state reconstructible, and if so why is it cached here?
- Does a global/singleton hide a missing dependency or lifecycle?
