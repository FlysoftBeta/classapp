# Lifetimes, ownership, and composition

Lifetime is an independent design dimension. A class is not process-bound
because its name says `Service`, and a domain boundary is not determined by how
long an object lives.

## Lifetime lattice

```text
process Runtime
  ├─ database handle and immutable runtime configuration
  ├─ event fan-out
  ├─ active AI execution controllers
  ├─ article import pool/tasks
  └─ other mechanisms that survive requests

request Scope
  ├─ immutable RequestIdentity
  ├─ UnitOfWork
  ├─ Actor / AuthorityService
  ├─ Composition
  ├─ lazily reused Facades and Services
  └─ Service-owned Facts

operation
  ├─ transaction
  ├─ captured ActorContext / credential epoch
  ├─ idempotency identity
  └─ immutable inputs for work that outlives the request

view/component
  └─ presentation lifecycle only
```

### Runtime

`Runtime` owns process-bound resources. Current examples are the SQLite handle,
`EventBusRuntime`, `AiExecutionRuntime`, and `ArticleImportRuntime`. A Runtime
member must have an explicit start/reconcile/stop story and must not capture a
request `Scope` or Actor.

Use process lifetime only when continuity across requests is semantically
required. A global map is not justified merely because constructing it locally
is inconvenient.

### Scope

`Scope` represents exactly one Action or HTTP request and is propagated with
`AsyncLocalStorage`. It owns immutable request identity, one `UnitOfWork`, and a
get-or-init object graph. Two calls for the same Service or Facade in a request
must receive the same instance; different requests must not share that instance.

Request identity contains server-established user/client identity and network
evidence. Lower layers consume `Actor` or explicit IDs rather than raw tokens.

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

## Facts

`Facts` are request-local, lazy knowledge owned by a stateful Service. They are
useful when either:

- a value should remain stable for the request, or
- repeated reading would be wasteful and staleness within the request cannot
  invalidate correctness.

Examples include the Actor's user/role snapshot and repeatedly queried group
membership.

Facts are not a general cache. For each proposed Fact, document:

1. key and value;
2. owning Service;
3. why request-level staleness is safe or desired;
4. every write path that updates or invalidates it;
5. rollback behavior;
6. whether a single batched read should populate adjacent facts.

### Read-your-writes

If a Service writes a fact it owns, subsequent reads in the same request must
observe the intended committed state. Update or invalidate the Fact as part of
the public Service operation.

Never publish an uncommitted value into Facts. If the enclosing transaction can
roll back, either defer the Fact update until commit or invalidate it on both
success and failure. Invalidation is conservative; retaining a value produced
by a rolled-back write is incorrect.

## Ownership rules

- A mutable fact has one owner. Other modules ask the owner; they do not mirror
  it in another cache.
- A background task has one lifecycle owner responsible for cancellation and
  restart reconciliation.
- A lock protects one named resource at the narrowest meaningful granularity.
- A pointer has one authority. Redundant `active` flags are forbidden when an
  active-ID pointer exists.
- Authorization is not a Service Fact unless the Service objectively owns the
  underlying relationship. Facades compose those facts into a decision.
- UI state cannot become the authority for server or offline domain facts.

## Review questions

Before adding state, answer:

- What creates it, and what destroys it?
- Can two requests see the same instance?
- Can an actor switch while an operation is in flight?
- What happens after server restart, browser navigation, or another tab's
  IndexedDB upgrade?
- Who invalidates it after a write?
- Is the state reconstructible, and if so why is it cached here?
- Does a global/singleton hide a missing dependency or lifecycle?
