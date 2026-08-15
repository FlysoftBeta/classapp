# Errors, incidents, and containment

ClassApp uses panic-like error propagation: if the current operation cannot
recover correctly, throw and let the error reach the nearest boundary that can
contain it. `try/finally` protects resources; `catch` is reserved for actual
recovery, translation with preserved diagnostics, or containment.

## Error categories

### Domain/public failure

The operation cannot proceed because of an expected state: wrong PIN, missing
membership, quota exhaustion, nonexistent resource, update already pending.
The server may use `PublicError` to provide a safe user message while retaining
a distinct diagnostic message/cause.

The current transport still represents these as failed Action Incidents rather
than a rich checked union. Do not introduce ad hoc HTTP status semantics or
stringly `ServiceError` categories to work around that. If a workflow needs a
recoverable branch as data—such as join requiring a password—model it explicitly
in the Action output.

### Contract violation

Malformed frames/arguments, impossible combinations, and server outputs that do
not match the registered contract indicate caller or implementation defects.
They are captured, correlated, and must not be converted to “offline.”

### Unchecked/internal panic

Invariant violations, unexpected database/IO failures, and programming errors
terminate the operation. They propagate to the protocol, HTTP, background-job,
event-fanout, or application boundary.

### Cancellation/unavailability

Actor epoch change, transport disconnect, and intentional cancellation are
control outcomes. They must stop stale work without committing partial
projections. They should not be confused with server rejection or cache
corruption.

## Catch policy

A `catch` must do one of the following and be commented if non-obvious:

- restore a valid state and return a truthful degraded result;
- translate while preserving `cause`/diagnostic evidence;
- attach cleanup failure to the primary error;
- contain one independent task so sibling work can continue, while reporting
  an Incident;
- recognize one narrow expected platform failure and use a proven fallback.

Forbidden catches include:

- swallowing any error and returning an empty list;
- treating IDB corruption, contract failure, or coding error as offline;
- replacing the primary exception with a cleanup exception;
- retrying every error, including deterministic validation failures;
- logging and continuing after an invariant may have been broken;
- making a valid remote response unusable merely because cache persistence
  failed.

`finally` must release leases, locks, timers, controllers, temporary files, and
loading state even when setup itself throws. Put resource acquisition inside the
scope protected by that `finally`.

## Containment boundaries

Containment is placed where failure of one unit must not terminate unrelated
work:

- WebSocket Action result codec;
- raw HTTP handler;
- event fan-out listener;
- detached client/background operation;
- maintenance timer iteration;
- process bootstrap/shutdown;
- React/application interaction boundary.

Containment records the original error. If Incident persistence itself fails,
log both errors and preserve the original panic; observability must not replace
causality.

## Incident model

Each occurrence receives a monotonically allocated internal row ID and an opaque
public ID. The public ID encrypts an encoded row identity so users can correlate
failures without revealing database position.

Grouping key:

```text
(environment, build_id, normalized top application frame)
```

The message is intentionally excluded because variable inputs would fragment a
single defect. Each group counts all occurrences but retains detailed payloads
for at most ten; later occurrences still receive public IDs with null details.

Captured context is bounded and must avoid secrets. Client incidents may link
recent related server Incident IDs so a single user-visible failure can be
traced across the wire. Stack source maps are resolved by build identity.

## Incident versus audit

| Incident                          | Audit                                   |
| --------------------------------- | --------------------------------------- |
| failure diagnostics               | successful authority exercise           |
| groups by build/frame             | ordered by administrative action        |
| may contain bounded stack/context | contains safe semantic summary          |
| generated at containment          | written with the successful transaction |
| visible to operations             | visible to root governance              |

Do not log an administrative attempt as success because an Incident exists, and
do not place stack traces into audit.

## Retry

Retry only when the operation is idempotent or has an idempotency key and the
failure is transient before visible output. AI model fallback, for example,
must not switch providers after output has become visible. Remote mutation
retries must not duplicate posts, top-ups, or file mutations.

Use bounded attempts, backoff/cooldown, and a terminal rejection. Infinite retry
hides failure and can hold stale actor context indefinitely.

## Client cache failure policy

Local persistence is a projection. When a remote read succeeds and cache write
fails:

1. report the cache failure with operation/actor/build context;
2. do not advance local coverage/revision;
3. return the valid remote payload to the online UI when it can be safely
   presented without the failed cache;
4. schedule bounded repair or rebuild at a later safe boundary.

Pending user decisions are different: a failed local write must be surfaced
because returning success would lose irreplaceable offline intent.

## Review checklist

- Which category is this error?
- Can this layer genuinely restore a valid state?
- Does cleanup preserve the primary failure?
- Does retry have idempotency and a bound?
- Does containment report actor, operation, build, and related incidents without
  secrets?
- Can the caller distinguish offline, cancellation, domain rejection, contract
  violation, and cache degradation?
