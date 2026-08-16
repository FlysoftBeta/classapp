# RemoteManager connection reliability

The working tree does not have a single class named `RemoteManager`. The role
is split across four cooperating modules in `client/interact/remote/` and the
recovery policy in `client/interact/remoteLifecycle.ts`:

| Module | Responsibility |
| --- | --- |
| `remote/transport.ts` | WebSocket lifecycle: connect, cooldown, forced offline, raw send/receive |
| `remote/client.ts` | Versioned Action/Event protocol, pending-request bookkeeping |
| `remote/session.ts` | Actor bindings, authentication, credential epochs |
| `remoteLifecycle.ts` | Event subscriptions, recovery ordering, heartbeat, authoritative app state |
| `sessionController.ts` | Warm-start bootstrap and login/lock gate policy |

This document records the failure model and the ownership rules. It is the
design memory for connection behavior; code details remain in the modules.

## Transport state machine

```text
stopped
  → connecting (socket created; 5s connect timeout)
  → connected
  → cooldown (socket close/error/timeout; 5s retry delay)
  → stopped
  → connecting ...

offline is a user-forced terminal-ish state:
  any state → offline (socket closed, timers cleared)
  offline  → stopped → connecting ...
```

`WebSocketTransport` owns the socket exclusively. It never parses frames and
never knows about users. Its `owns(socket, kind)` guard means a stale socket
event can never mutate a newer attempt. There is exactly one physical socket;
it is deliberately not restarted by protocol or session code.

Connection constants:

- `CONNECT_TIMEOUT_MS = 5_000`: a socket that has not opened is closed.
- `COOLDOWN_MS = 5_000`: fixed retry spacing. There is no exponential backoff;
  the deployment is a concealed LAN and a longer backoff only delays recovery.

## Pending Actions: no per-Action timeout

`remote/client.ts` keeps a `Map<requestId, PendingAction>`. As of the media
work, pending Actions have **no per-request timeout**. A request may stay
pending for as long as the transport stays connected; yt-dlp search and AI
generation are intentionally allowed to be slow.

A pending request is settled only by:

1. a correlated server `response` frame for that request id;
2. transport transition out of `connected` (`DISCONNECTED` rejection of every
   pending request);
3. actor credential invalidation (`ACTOR_CHANGED` rejection for that binding);
4. a local `transport.send` failure before the frame was written.

The explicit timeout and its `timedOut` late-response bookkeeping were removed
because they created a second failure authority beside the socket. The socket
is the connectivity authority: if it is healthy, a slow legitimate answer is
not an error; if it is not healthy, the transport transition rejects pending
work.

Trade-off to preserve: a server that accepts a frame but never answers would
leave a pending entry indefinitely while the socket remains open. The protocol
server always answers a well-formed request, and malformed frames are rejected
immediately, so an unanswered request is treated as an operational Incident
condition rather than as a request to retry in place. Retry-safe operations
belong to proposal flushing, not to Action retries.

## Frame and authentication model

One physical socket may carry several immutable actor bindings. Every request
frame carries `user`; the server rejects a request for a user whose binding is
not authenticated.

`RemoteSession` owns:

- `bindings: Map<userId, Binding>` with `token`, monotonic `credentialEpoch`,
  `authenticated` flag, and authentication waiters;
- `activeUserId` / `activeEpoch` for the current UI actor;
- re-authentication of every binding whenever the transport reaches
  `connected`.

Binding rules:

- Re-binding a user with a different token first rejects its waiters and
  notifies listeners with the old credential epoch, then replaces the binding.
- A failed `authenticated` frame deletes the binding; if it was the active
  actor, the invalid-session handler clears local session state and runs the
  authoritative gate probe.
- `waitUntilAuthenticated` has its own 5s timeout. It is a gate for starting
  Actions, not an Action timeout; slow server responses remain unaffected.
- `remote.resubscribe` from the server triggers re-authentication and recovery.

## Recovery ordering

`RecoveryCoordinator` is single-flight. Events arriving while a recovery is
running are queued and replayed after authoritative repair, never concurrently:

```text
connected (or remote.resubscribe)
  → refresh access / app state
  → refresh conversation access
  → flush pending proposals
  → recover Post revisions
  → refresh authoritative snapshots
  → replay queued events in arrival order
  → idle
```

The order is load-bearing:

1. access first, so dormant proposals are excluded when access disappeared;
2. proposals before snapshots, so canonical responses participate in merge;
3. revisions before events, so missed mutations are repaired;
4. event replay last, so low-latency changes received during recovery are not
   overwritten by an older snapshot.

A token change stops the coordinator, invalidates resources, and resets actor
presentation projections. Reconnect is per actor even though one socket may
carry several bindings.

## Bootstrap and heartbeat

`sessionController.bootstrapSession` warm-starts from the local session row
before the network is consulted. If the socket is not connected it races
`waitUntilConnected()` against 5s; a slow start renders the cached gate and
continues waiting in the same coroutine so the authoritative probe and device
auto-login still run without a page reload.

`startHeartbeat()` runs every 120s and only while the app is unlocked:

- `probeAppState()` revalidates the gate and refresh flags;
- `syncPendingMutations()` flushes durable offline proposals.

The heartbeat is currently the application-level liveness signal. The raw
WebSocket has no explicit ping/pong; a dead peer is observed through the
browser's socket close path, at which point transport enters cooldown.

## Event fan-out reliability

Events are latency optimizations, not durable state. `EventBusRuntime` on the
server publishes complete rows or invalidation hints. Client subscriptions
receive validated payloads; validation failures are reported as client
Incidents and never mutate projections. During recovery, events are parked in
`RecoveryCoordinator.queuedEvents` and replayed exactly once after the
authoritative repairs above.

## Failure windows and current limitations

- The socket has connect timeout but no application ping. A silently wedged
  but open WebSocket is detected by heartbeat failures, not by a transport
  timer.
- `waitForCurrentAttempt` only waits for the attempt observed at call time;
  callers that need eventual connection use `waitUntilConnected`.
- Forced offline is user intent and wins over automatic retry until explicitly
  cleared.
- Pending requests are bounded by server responses or disconnect, not by time;
  server Action handlers therefore must always terminate (the server-side
  timeout for media work lives in the provider invocation, not in the client).
- Events lost during disconnect are repaired by snapshot/revision recovery,
  not by the WebSocket replay buffer.

## Review checklist

1. Does new connectivity code own the socket or merely observe `transport`?
2. Can a stale socket/callback mutate a newer attempt?
3. Can a slow Action be rejected by anything other than disconnect, actor
   invalidation, or send failure?
4. Is every event subscription symmetric and cleaned up on token change?
5. Does recovery preserve the access → proposals → revisions → snapshots →
   event replay order?
6. Is actor context captured once per asynchronous operation?
