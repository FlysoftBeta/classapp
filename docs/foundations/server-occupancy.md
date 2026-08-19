# Occupancy and process composition

ClassApp's server is one operating-system process and one SQLite file. The
recent process-composition work is not a step toward a fleet. It exists because
**what remains alive after a call returns** is a different question from
**which layer is allowed to decide, mutate, or persist**. Mixing those questions
is how this codebase grew a request-local Fact cache that was not isolation, a
process singleton that request graphs could not see, and domain work on the
thread that owned client sockets.

This document owns that distinction. Layer rules remain in
[architecture](../architecture.md) and [lifetimes](./lifetimes-and-ownership.md).
The accepted cutover is recorded in
[0001](../decisions/0001-coordinator-executor.md). Read this when adding work
that might outlive a request, touch a socket, start a timer, talk to the
launcher, or hold a byte stream.

## Occupancy is not a layer

Facade / Service / Data answers:

- who may select an actor-dependent path;
- who owns an objective mechanism;
- who may SQL.

Occupancy answers:

- after this call returns, what still exists;
- which thread, connection, or child still holds it;
- who reconciles it after crash or restart;
- what another concurrent request is allowed to observe.

A name is not occupancy. A Service can be a request-scoped view of sticky work.
A module with `Runtime` in the title can still be a request graph. A global
locator can hide a second occupancy that the current request is not on.

The useful test is leftover:

```text
leftover(call) = { state that still exists after return }
                ∪ { who can observe it }
                ∪ { what restart does to it }
```

If leftover is only durable rows plus a cloneable result, the call was job
occupancy. If leftover is an in-flight job identity plus process resources, it
was sticky occupancy. If leftover is a socket and its bindings, it was protocol
occupancy. If leftover is a module-global map with no restart story, occupancy
was not designed.

## Why the process stays one

The product is a concealed-LAN school deployment. The launcher owns directory
switching and the rollback watchdog. Protocol sessions and in-memory fan-out
must see one another. There is one SQLite writer lock that matters.

A cluster of server processes would split those occupancies: sessions on one
child, rollback on another, events on a third. That solves a scale problem this
product does not have, and it creates an ownership problem it cannot operate.
Per-domain worker pools would split Facades that compose several Services in
one transaction. A request-long SQL snapshot held across `await` would pin WAL
frames and contradict “no SQLite lock during I/O.”

The failure to solve is therefore:

- synchronous SQL stalling the thread that must keep sockets and Range leases
  alive;
- Read Skew across auto-commit statements on one connection;
- authorization TOCTOU if occupancy is frozen in a request memo instead of
  re-read under the write lock.

Concurrent readers are a consequence of WAL plus one connection per occupancy
that is allowed to SQL. They are not a reason to invent a second database.

## Three occupancies

Not “stateless versus stateful.” Three kinds of leftover:

### Protocol occupancy

Sticks to a client connection. It may bind several immutable actors onto one
socket. It must not run domain SQL. It must not own sticky job identity. Its
restart story is: the client reconnects and re-authenticates.

### Job occupancy

One Action or authenticate frame. The leftover after return is at most:

- SQLite rows on the connection that owned the job;
- cloneable events and sticky commands in the result.

There is no leftover Scope, Actor, open transaction, timer, child process, or
socket. A worker crash fails the in-flight Action. The next job on that
occupancy is a different request graph.

### Sticky occupancy

Sticks to a domain job identity until a terminal state: an AI run, a media
materialization, an import, a capture, an upload reconcile, a deployment
pending confirmation. Process resources (abort controllers, download slots,
child processes, cloud timers, launcher IPC) live here. Restart must reconcile
from SQLite, not from the heap.

Sticky occupancy does not own client connections. It must not capture a request
Scope or Actor. If the work can outlive the actor who started it, capture
immutable identifiers at the start; do not reread a mutable request principal
after `await`.

The process composition root hosts protocol occupancy, sticky occupancy, and
the pool that creates job occupancy. It is not a fourth occupancy and not a
business Facade. Putting a product rule there because “it has to run somewhere”
is layer-name reasoning.

`Scope` is also not occupancy. It is the request graph that rides on job
occupancy or on a short Coordinator-thread HTTP lease. Two calls in one request
share one graph; two requests never share that graph.

## Why Actions leave the socket thread

Domain Actions are job occupancy. The thread that owns sockets must remain able
to read, write, and drop connections while SQL runs. `better-sqlite3` is
synchronous; SQL on the protocol occupancy is a stall of every other client.

Isolation is the SQLite snapshot of the connection that owns the work, for the
duration of a short `BEGIN`. It is not a request-local predicate cache on the
socket thread. That cache froze mid-request authority without providing snapshot
isolation, and it invented an invalidate protocol of its own.

The job is cloneable identity and arguments. It is not a borrowed database
handle, a borrowed socket, or a borrowed Actor object. Database objects never
cross threads.

## Why some work cannot be job leftover

Job leftover cannot include:

- file descriptors and Range/multipart leases;
- child processes, interval timers, or abort maps;
- launcher IPC and directory-switch intent;
- the set of live protocol sessions;
- cloud poll that must not reset because a worker came and went.

Those are protocol or sticky occupancy. They stay on the process composition
root. Jobs reach them only through seams. A request Service that “just holds a
singleton” is claiming sticky occupancy without a host, a restart story, or a
seam. Every worker then has a different empty singleton. Production looks like
a development occupancy that was never installed.

Development may omit an occupancy that only exists under the launcher (update
directories, confirm IPC). That is an occupancy absence. It is not a boolean
inside a request graph, and it is not the same event as “this job cannot see
the occupancy that is running next door.”

## Seams between job and process occupancy

There are three legitimate seams. They are not interchangeable.

### Cloneable job

The protocol occupancy sends identity and arguments. The job occupancy runs
Facade → Service → Data on its own connection. It returns outcome, events, and
commands. Use this for ordinary domain reads and writes.

The job must not need a socket. It must not need a process timer to compute its
result. It may *ask* sticky occupancy (next two seams) but it does not *become*
it.

### Post-commit command

After the job's write is durable, the composition root applies cloneable
commands: “execute the AI run already reserved,” “ensure this track is
materialized.” The command must not be required to compute the Action result.
If the process dies between commit and command, sticky restart reconciliation
must complete or fail the durable intent. Commands are not a second transaction
protocol.

### Synchronous RPC

The job needs a result from sticky occupancy *during* the job, while holding no
SQLite transaction: a bounded search, an update status, an abort. Arguments and
results are cloneable. A public, actor-visible failure must remain a public
failure after crossing the seam. An unexpected failure is still an Incident on
the occupancy that panicked.

Wrong seam, typical cost:

- treating a 512 MiB archive as an RPC argument copies occupancy across
  threads;
- treating a status read as a command yields no result;
- treating sticky timers as job leftover gives each worker a private occupancy;
- running the Action on protocol occupancy is simpler until SQL blocks
  heartbeats and Range.

HTTP is not a fourth seam. It is Coordinator-thread occupancy for work whose
leftover *is* the byte lease. Authorize with a short Scope, then hold the
stream here. Do not occupy a job for the transfer. HTTP status codes remain
transport outcomes, not the domain error model.

## Boot installs occupancy

The launcher owns installation roots, the child, directory switching, and the
rollback watchdog. The child starts empty. Occupancy exists only after an
immutable description is installed: application and data roots, build identity,
ports, renderer paths, HTTPS material, update directories, proxy policy.

That installation is a process event. It is not “the first module to import
environment variables wins.” Job occupancies created later receive a clone of
what they are allowed to host. They do not receive occupancies they must not
host. A worker with update directories and launcher IPC would be a second
sticky occupancy with `process.exit` instead of a directory switch.

`env` snapshots taken at import time are occupancy installation, not a
convenience alias. They are valid only after the description is installed and
must not be read to decide whether a neighboring occupancy exists.

## SQLite connections are occupancy

One file, several connections, never a handle crossing threads.

- Protocol-adjacent SQL and sticky short transactions use the composition
  root's connection.
- Job SQL uses the job's connection.
- WAL snapshots prevent Read Skew for the duration of a short read
  transaction.
- Writers use `BEGIN IMMEDIATE` and re-read authorization and quotas under
  that lock.
- No connection holds a snapshot across `await`. External work (network,
  render, model, archive) happens between short transactions, with durable
  intent recorded first when the process can die in between.

`SQLITE_BUSY` waits a bounded timeout. It is not permission to keep a write
lock while downloading.

## Events are Coordinator occupancy

Fan-out to protocol sessions is process occupancy. Jobs return events with the
result; the composition root delivers them after the job is done. Sticky
occupancy publishes after its own short commit. A worker must not deliver to
sockets it does not own.

Events are repair hints, not a durable log and not a second database. Missed
events are repaired by access refresh, revision catch-up, and snapshots on the
client. Re-authentication refreshes the server-side channel set.

Publication after commit is an occupancy rule as well as a transaction rule:
protocol occupancy must not observe a fact the job rolled back.

## Request graphs must ask occupancy, not impersonate it

`Scope` and Composition exist so one Action has one Actor, one UnitOfWork, and
one object graph. They are allowed to *call* an explicit sticky port. They are
not allowed to *be* the owner of process leftover.

A hidden import of a global database handle, a module-global manager, or
`currentScope()` from a process-bound mechanism conceals a second occupancy.
The next refactor will put the request graph on another thread and the
singleton will answer as if the occupancy were absent.

The inverse error is also occupancy confusion: constructing sticky leftover
inside a job because the job has a convenient `db` handle. The job's connection
is not the sticky restart story.

## Placement follows leftover

Do not organize by layer-name fashion, by which neighborhood is currently
large, or by where construction is convenient. Organize by leftover.

A type belongs with the occupancy whose leftover it is. A request-scoped view
of sticky work has no leftover of its own; it may sit with other request
mechanisms because it is not an owner. A port names what a neighboring
occupancy may be asked. It is not a second heap and not a place to hide
timers, children, or sockets.

When leftover is mixed into a request graph, the next composition change will
move that graph and the leftover will answer as absent. When leftover is
copied into every job, each worker becomes a competing owner. When leftover
is parked in a locator because “it has to live somewhere,” occupancy was not
designed.

The composition root may host occupancy. It must not become the product rule
for that leftover. Names and suffixes are reminders. The leftover test is the
rule.

## Naming

`Coordinator` is the process composition root. The `Runtime` suffix is for
sticky occupancy: process-bound domain jobs with a reconcile/stop story. It is
not a synonym for “the server.”

`Service` is a coherent objective mechanism. It is not a lifetime marker. A
request-scoped Service that only forwards to a sticky port is a view, not a
second owner.

Avoid `manager`, `helper`, `util`, and `state` without a specific noun. Those
words usually mean leftover was not designed.

## Review questions

Before adding server work, answer:

- What is leftover after return, and who observes it?
- Is this protocol, job, or sticky occupancy? If none, why does it exist?
- Which seam reaches neighboring occupancy: job, command, or RPC?
- What does process restart do? What does worker crash do?
- Does this capture an Actor, or only immutable identifiers?
- Does any SQLite transaction stay open across `await`?
- Would a worker-local singleton disagree with the composition root?
- Is “disabled” an occupancy that was never installed, or a seam that cannot
  see one that was?

If two occupancies would both consider themselves authoritative for the same
mutable fact, stop. Singular ownership is not optional at this scale; competing
truths are the usual bug.

## Non-goals of this composition

Unless the product premise changes, occupancy design does not exist to enable:

- multiple server processes or per-domain databases;
- holding business rules on the composition root because it is convenient;
- a generic RPC capability layer that bypasses Facades;
- request-long snapshots as a substitute for re-reading under a write lock;
- treating development's omitted occupancies as the production truth.

[0001](../decisions/0001-coordinator-executor.md) records the cutover and the
rejected alternatives. This document records why leftover, not filename, is the
question that cutover was answering.
