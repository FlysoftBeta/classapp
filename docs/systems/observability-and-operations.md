# Observability and operations

ClassApp is operated as a small on-premises system, not as a cloud fleet with a
full telemetry platform. Operational design should maximize diagnostic value
per retained byte and per administrator decision. The existing primitives are
structured audit records, durable Incident grouping/details, process logs,
health/startup evidence, build IDs, and explicit administration workflows.

## Three evidence streams

| Stream      | Question answered                                        | Must not become                     |
| ----------- | -------------------------------------------------------- | ----------------------------------- |
| audit       | who deliberately performed which privileged action?      | debug log or content copy           |
| Incident    | which unexpected failure occurred, where, and how often? | checked business-error table        |
| process log | what did the runtime/launcher do over time?              | unbounded secret-bearing transcript |

These streams correlate but do not substitute for each other. A failed admin
operation may create an Incident and no success audit. A denied request is a
checked result and normally not an Incident. A launcher rollback may need a log
and operational state transition even when no Actor initiated it.

## Correlation model

Every unexpected failure crossing a containment boundary receives a public
Incident ID. Grouping should use stable diagnostic identity such as final stack
site, environment, and build—not a volatile user-facing message. Retain bounded
detail samples while still counting/reporting later occurrences.

Useful fields are:

- build ID and server/client environment;
- operation/resource label and request correlation where available;
- stable entity IDs and actor ID when necessary and authorized;
- state machine phase, revision/generation, and causal Incident IDs;
- sanitized error type and stack.

Do not capture tokens, provider keys, request bodies, prompts, article content,
workspace files, PINs, certificate keys, or arbitrary serialized objects.

## Containment boundaries

Contain an error only where the system can preserve a coherent outer contract:

- transport converts an unexpected request failure into Incident protocol;
- detached browser work reports a client Incident without crashing unrelated UI;
- background loops record failure and continue only if the next iteration is
  independent and state is still valid;
- update/startup code records phase and lets launcher rollback own activation;
- cleanup reports secondary failure without replacing the primary error.

A broad `catch` is not resilience. After catching, the code must say which
invariant still holds, what state is visible, and how retry/recovery occurs.

## Operational state machines

For startup, updates, HTTPS, backups, render jobs, and reconciliation, expose
state rather than isolated booleans:

```text
phase + generation/build + started_at + last_progress + terminal outcome
```

Progress markers must certify durable work. “100%” or “active” cannot be written
before the referenced artifact/state is complete. On restart, reconcile staged
files, database rows, and active pointers; logs alone are not recovery state.

## Health and readiness

Differentiate:

- process alive;
- database open and migrated;
- HTTP/WebSocket accepting requests;
- active client generation available;
- HTTPS/certificate usable for LAN clients;
- optional external provider reachable.

Do not make the core app unavailable because an optional AI provider or update
source is down. Conversely, a listening port is not proof that Shell assets,
database, or active generation are coherent.

## Operator workflows

The administration workbench is the primary operations console. Operations
must be narrow, role-gated, explain irreversible effects, and return structured
outcomes. Incident testing should exercise the real containment/reporting path.
Log archives and backups are privileged downloads and use short-lived,
authorized capabilities rather than guessable static paths.

An operator should be able to answer:

1. Which build and data/schema generation are active?
2. Did the last startup/update complete, roll back, or remain staged?
3. Is a failure client-only, server-only, or cross-stack causal?
4. Which actor performed the last relevant privileged change?
5. What repair is safe, idempotent, and observable?

Avoid “repair” buttons that directly edit several owners from the UI. Provide a
single server operation whose owner checks preconditions, commits coherent
state, audits success, and reports Incident failure.

## Metrics without a metrics platform

Prefer bounded, actionable counters and timestamps stored with their owning
mechanism: Incident occurrence count, pending mutation count, last successful
reconciliation, update phase, quota usage, billing ledger totals, and queue
age. Do not build a generic analytics layer unless an operational question and
retention policy justify it.

Sampling must never affect correctness. Diagnostic writes should not hold a
business transaction across network/filesystem work. If audit is part of the
meaning of a privileged success, place the minimal audit row in the same safe
transaction; detailed log generation remains outside.

## Runbook pattern

Each failure-prone subsystem document should eventually provide:

- symptom and user-visible distinction;
- authoritative state and inspection path;
- safe read-only diagnosis;
- idempotent recovery or explicit rollback owner;
- evidence confirming recovery;
- escalation data with secrets removed.

Runbooks must not instruct operators to delete the database, IndexedDB, active
version, or certificate state as a first response. Destructive reset can erase
the evidence and the only copy of offline intent.

## Change review

For any new long-running or privileged operation, define phase transitions,
correlation, failure containment, restart behavior, audit semantics, redaction,
and a bounded diagnostic test. If a failure can only be debugged by adding
`console.log` after it occurs, the design lacks an owned observation boundary.
