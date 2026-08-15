# Server model

ClassApp separates transport mechanics, public business entry points, domain
mechanisms, and persistence:

```text
Transport -> Action / HTTP Adapter -> Facade -> Service -> Data
```

## Lifetimes

Business names do not imply object lifetimes.

- `Runtime` is bound to the server process. It owns database resources,
  background jobs, external client pools, event fan-out, and other mechanisms
  that must survive a request.
- `Scope` is bound to one Action or HTTP request. It lazily initializes and
  reuses Actor, Facades, Services, and the request Unit of Work.
- An operation is a transaction or a durable asynchronous command. A command
  that outlives its request captures immutable input and never retains Scope.

Scope initialization follows get-or-init semantics: a Service is constructed
on first use, then the same instance is returned for the rest of the request.
Services may therefore hold request-local state.

## Facts

`Facts` are lazy request-local values owned by a stateful Service. They are
appropriate when a value must remain stable for the request or when stale data
cannot change the correctness of that request. Common examples are the Actor's
user snapshot, roles, and repeatedly inspected membership facts.

Every Fact has one owning Service. Other Services use the owner's public API;
they do not duplicate its cache. A write operation either updates or
invalidates the Facts it owns. Values written inside a transaction must not be
published to Facts as committed values before commit. Invalidating a Fact on
rollback is safe; retaining an uncommitted replacement is not.

Facts are not a general cache and do not outlive Scope.

## Boundaries

### Transport and Actions

Transport owns WebSocket framing, HTTP streaming, multipart and Range
semantics. Actions validate and translate wire data. They call Facades and do
not import Data or construct Services.

An HTTP route is an Action adapter for operations that require raw HTTP
semantics. It follows the same Facade boundary.

### Facades

Facades are the public business API. They own Actor-dependent authorization,
choose a legitimate path through the system, coordinate Services, and establish
cross-Service transaction boundaries.

`ActorFacade` serves an authenticated user. Explicit public and system Facades
serve anonymous/client and Runtime callers. There is no generic privileged
bypass.

### Services

A Service is an independent business mechanism. It may expose objective
operations that do not inspect an Actor. Direct Service calls may be
unauthorized, but they must never create a domain-invalid state. Domain
invariants, idempotency, state transitions, and domain events belong here.

### Data

Data owns SQL and database row mapping. SQLite bitsets remain private Data
representations and are converted to semantic objects before crossing the
server boundary.

## Transactions and events

Cross-Service changes run on the Scope Unit of Work and therefore share one
database connection. Observable events are registered with `afterCommit` and
published only after the outer transaction commits. Network, rendering, and AI
provider calls never run while a SQLite transaction is held.

## Import direction

The allowed dependency direction is:

```text
protocol/http -> actions -> facades -> services -> data
runtime --------------------^       -> infra/runtime dependencies
```

Temporary reverse imports are migration defects and must be removed rather
than documented as exceptions.
