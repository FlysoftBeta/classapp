# Authentication and client trust

ClassApp authenticates both a user and a managed client context. A six-digit PIN
identifies a user, while the server maintains an opaque client identity from
network/device evidence and administrator admission state. Neither alone is the
complete gate.

## Actors and evidence

- user ID is the stable principal;
- session token binds user and client server-side;
- client ID is an opaque server-generated identity;
- IP, best-effort LAN MAC, and user agent are evidence, not user identity;
- handles and usernames are mutable presentation fields;
- one physical WebSocket can carry multiple user bindings, each authenticated
  independently and labelled on every frame.

MAC is best effort because browsers do not expose it. The server may inspect
the local neighbour table, but failure to resolve a MAC must not create a false
identity. Forwarded IP headers are trusted only from configured proxy peers.

## Connection flow

```text
HTTP/WebSocket request
  → identify network client evidence
  → get-or-create client record
  → WebSocket hello(build ID)
  → client sends authenticate(user ID, token) per binding
  → server verifies token, claimed user, ban state, and bound client
  → subscribe binding to actor-specific event channels
  → Actions carry the same user ID on that binding
```

The protocol rejects an Action for an unbound actor. The token is validated at
binding time rather than repeatedly exposed to domain code. Logout removes only
the relevant binding and session.

When membership changes, the server sends a resubscribe hint. The client
reauthenticates that actor binding so the server atomically replaces its channel
set without reconnecting other actors.

## Application boot gate

The browser warm-starts from a locally persisted session when available so the
offline UI can appear. It then waits for the server when possible and performs:

1. client-state probe/client ID discovery;
2. device auto-login/binding path;
3. ban and lock checks;
4. authoritative application-state projection;
5. PIN login or OOBE when required;
6. actor-scoped initial resource refresh.

Local session data is a boot hint, not proof of current server access. Its
actor row includes the last confirmed client lock, effective user disable
state, and global system-lock flag, so an offline warm start preserves the last
known gate rather than assuming the application is unlocked. The effective
state remains distinct from the global flag because administrators can bypass
a system lock. A banned, deleted, or invalidated identity is cleared when the
authoritative gate rejects it. Offline startup may show cached actor data but
cannot perform server mutations.

## PIN and OOBE

PINs are HMAC/hash material stored only on the server. OOBE uses a short-lived
identity/token to collect stable profile fields and replacement PINs, then
creates a normal session. Validation includes uniqueness and collision checks;
the client never receives hashes or server PIN secrets.

Authentication error messages must avoid turning the PIN endpoint into a user
enumeration oracle. Rate limiting belongs to the client/authentication
mechanism, not React timers.

## Client admission and binding

A client may be whitelisted, bound to a specific user, temporarily recognized,
or locked. These are separate states. Admin help text must explain:

- what evidence contributes to identification;
- that MAC resolution is best-effort and LAN-specific;
- how long temporary clients persist;
- what whitelist and binding each permit;
- why deleting a client invalidates its admission but not user history;
- why a user ban and a client lock are different controls.

Client events are addressed by client channel so an administrator can force a
gate refresh. Purging a user clears client references through `ClientService`;
it does not leave a dangling bound user.

## Client actor context

Every request captures both stable actor ID and credential epoch. Pending calls
record the epoch; a token replacement or logout rejects only calls from that
credential generation. Response frames must match the requested actor. Event
frames for another inactive actor are not applied to the active UI.

Long local operations retain `ActorContext`; they do not repeatedly consult
`session.getUserId()`. This prevents one reconcile batch from writing half its
rows under actor A and half under actor B.

## Security boundaries

- server Facades authorize every mutation even when UI controls are hidden;
- query-string tokens exist only where raw browser downloads require them and
  must be minimized because URLs leak to history/logs;
- session/PIN/provider secrets never enter audit or Incident context;
- client identity evidence is server-private; only opaque ID and operational
  state reach ordinary UI;
- CORS accepts only same-host origins and varies on Origin;
- forwarded protocol/IP are trusted only under configured proxy assumptions;
- lock/ban changes invalidate relevant sessions/bindings and publish refresh
  signals.

## Verification matrix

- new unrecognized client, whitelisted client, user-bound client;
- wrong PIN, OOBE, automatic login, logout, session expiry;
- ban/mute/lock during an active session;
- membership change and resubscription;
- two actors on one transport with one credential replaced;
- offline warm start followed by rejection;
- actor switch during local reconcile/background retention;
- proxy spoof attempt and missing MAC;
- Chrome 70 secure and legacy-redirect entry.
