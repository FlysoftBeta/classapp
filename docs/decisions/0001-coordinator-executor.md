# 0001: Coordinator, Executor pool, and StickyRuntimes

Status: accepted
Date: 2026-08-18
Owners: server/runtime, server/protocol, server/infra/db

## Context

The server ran in one Node thread with one `better-sqlite3` handle. WAL was
on, but concurrent readers could not exist. `Facts` memoized a few request
predicates to reduce repeat SELECTs and to freeze mid-request authority; they
did not provide snapshot isolation. WebSocket `ProtocolSession` ran Actions
on the same thread that owned the socket.

ClassApp remains one launcher child and one SQLite file. The failure to
solve is event-loop blocking and Read Skew across auto-commit statements,
not write throughput.

## Invariants

- One OS process; no cluster; no per-domain databases.
- `better-sqlite3` `Database` objects never cross threads.
- Domain Actions do not run on the thread that owns client sockets.
- StickyRuntimes do not own client connections.
- Read skew of SQL state is prevented by WAL snapshots in a short `BEGIN`,
  not by a request-local Fact cache.
- Write skew and authorization TOCTOU are prevented by `BEGIN IMMEDIATE`
  plus re-reading invariants under the write lock.
- Network, rendering, and model calls do not hold a SQLite transaction.
- Events are not a durable log; they fan out from the Coordinator after
  commit.

## Decision

The process composition root is `Coordinator`. It owns:

- HTTP/WebSocket protocol sessions and the in-memory EventBus;
- StickyRuntimes (AI execution, media jobs, article import, teach-document
  capture, upload reconcile, storage eviction);
- a Coordinator SQLite connection for protocol-adjacent SQL and Sticky
  short transactions;
- an `ExecutorPool` of `worker_threads`, each with its own SQLite
  connection.

An Action or authenticate frame is a job: the session sends cloneable
identity and arguments to a worker. The worker constructs a `Scope`,
runs Facade/Service/Data, and returns `{ outcome, events, stickyCommands }`.
The Coordinator delivers events and applies commands (for example
`ai.execute`).

HTTP metadata still enters a Coordinator-thread `Scope` because Range,
multipart, and media streams are leases on this thread. Streaming routes
authorize with that Scope, then use StickyRuntime leases and `BlobStore`.

`Facts` are removed. Authority and membership are re-read from the
connection. Isolation is the SQLite snapshot of the current transaction.

## Alternatives considered

- Node cluster of `server.js` processes: would split EventBus, WebSocket
  sessions, and launcher rollback. Rejected.
- Per-Service worker pools: Facades compose multiple Services in one
  `UnitOfWork`. Rejected.
- Holding a request-long snapshot across `await`: pins WAL frames and
  contradicts the existing “no SQLite lock during I/O” rule. Rejected.
- Keeping Facts as an acceleration cache: the cached keys were not the
  isolation boundary, and invalidate/read-your-writes was a protocol of
  its own. Rejected.

## Failure and recovery

Worker crash fails the in-flight Action; Incident capture on that worker's
connection if possible. Sticky job identity lives in SQLite (AI run rows,
media assets, upload intents) and is reconciled on Coordinator start.
A worker must not retain Scope, Actor, or an open transaction when the job
returns. `SQLITE_BUSY` waits `busy_timeout`; writers use short IMMEDIATE
transactions.

## Consequences

WAL concurrent reads become possible. Protocol threads stay responsive
during SQL. Sticky CPU/I/O still shares the Coordinator event loop except
where already offloaded to child processes. Write lock remains one.
Production must ship `executor.mjs` beside `main.mjs`. Each is its own
monolithic SSR bundle (`codeSplitting: false`); they are not one multi-entry
Rolldown build.

## Verification

- Typecheck of the Coordinator/Executor/Sticky ports.
- Action frames no longer call `dispatchAction` on the WebSocket thread.
- `Facts` and `getDb()` are absent from `server/`.
- Worker entry sets `RuntimeConfig` before importing `env.ts`.
- Release assembly emits both `main.mjs` and `executor.mjs`.
