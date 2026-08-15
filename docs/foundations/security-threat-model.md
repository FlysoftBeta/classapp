# Security and threat model

Security in ClassApp starts from its actual deployment: a small school
community on a concealed but not trusted LAN, shared or managed Chrome 70–80
clients, one Node/SQLite server, and an application that must keep useful data
offline. The intranet reduces Internet exposure; it does not make browsers,
students, imported files, local storage, or LAN traffic trustworthy.

This document defines design boundaries. It is not a claim that every current
mechanism has received a formal security audit.

## Assets and trust zones

| Asset                               | Primary owner                     | Main risks                                        |
| ----------------------------------- | --------------------------------- | ------------------------------------------------- |
| account identity and session        | Auth Service / Actor boundary     | impersonation, stale actor, shared-device leakage |
| authority assignments               | Authority Service and Facades     | confused deputy, privilege escalation             |
| community and private content       | owning domain Service             | unauthorized projection, cached residue           |
| AI keys, quota, and billing facts   | AI configuration/billing owners   | secret disclosure, unbounded spend                |
| update artifacts and active version | launcher/update chain             | arbitrary-code installation, partial activation   |
| server database and workspaces      | Runtime/infra and owning Services | loss, exfiltration, inconsistent purge            |
| offline projection                  | client Interact/Data              | cross-user disclosure, rollback, quota deletion   |
| incident and audit records          | Incident/Audit Services           | secret capture, misleading attribution            |

Trust boundaries are crossed at the browser input, WebSocket/HTTP transport,
authentication-to-Actor conversion, administrative Facade, imported archive,
AI provider, filesystem, update package, and launcher IPC. Validate again at
the boundary that owns the consequence; UI controls are not authorization.

## Threat assumptions

Assume that a user can inspect and modify browser state, replay requests, call
Actions without the UI, submit malformed archives or rich content, disconnect
at any instruction boundary, and retain files previously materialized offline.
Assume other LAN hosts can discover ports and attempt requests. Assume a shared
device may be handed to another user. Do not assume the attacker controls the
server OS; if it is compromised, application-level authorization is no longer a
sufficient boundary.

The system is not designed to hide downloaded plaintext from the current OS
user. Offline availability and strong protection from a device owner are
incompatible without a separately managed encryption/key system. Do not imply
at-rest confidentiality that the implementation does not provide.

## Required security invariants

```text
accepted mutation ⇒ authenticated Actor ∧ authorized Facade path
Actor used after await ⇒ Actor captured for this Scope, not reread globally
client-visible object ⇒ current Actor may observe that projection
administrative success ⇒ mutation committed ∧ audit summary committed safely
active update pointer ⇒ artifact verified ∧ generation complete
untrusted archive entry ⇒ normalized path remains inside owned workspace
logout complete ⇒ session invalidated ∧ user-bound in-memory state detached
```

Authorization belongs at public Facades because legitimacy is actor- and
path-dependent. Services enforce objective invariants and must not become a
second, scattered permission system. Data primitives never infer authority.

## Transport and browser posture

- LAN HTTPS is an identity and integrity boundary, not cosmetic encryption.
  Shell discovery, certificates, ports, WebSocket upgrade, CORS, and update
  origin rules form one contract.
- Permit origins and methods deliberately. Never broaden CORS to fix a local
  development symptom without tracing production Shell and multi-port traffic.
- Treat every Action payload, query parameter, header, multipart field, archive
  member, and stored client row as untrusted at its receiving boundary.
- Zod validates wire shape. Semantic validation still belongs to the domain
  owner: membership, size, revision, ownership, state transition, and quota.
- Chrome 70–80 compatibility is also a security property: an unsupported API
  that silently disables validation, hashing, rendering, or boot is a failure.
- Content rendering must use framework escaping or an explicitly reviewed
  sanitizer. Never introduce raw HTML because content originated from a
  supposedly trusted teacher or AI response.

## Sessions, clients, and shared devices

A session token is a bearer capability. Keep it out of URLs, logs, incidents,
audit details, and downloadable diagnostics. Authentication establishes an
immutable Actor for one request Scope; it does not make browser state trusted.

Client identity supports managed-device and LAN workflows but is not a human
identity. Never authorize a business action solely from a device identifier.
On actor change or logout, detach subscriptions and clear all actor-bound
in-memory projections before another user can render. Persistent offline data
needs an explicit ownership/purge policy; closing React components is not
deletion.

## Files, documents, and imports

- Normalize archive paths, reject traversal and ambiguous names, enforce entry
  count and expanded-size limits, and never trust a compressed size alone.
- Use generation/staging directories and atomic publication. A partially
  extracted or rendered artifact must never become active.
- Treat document renderers and native binaries as high-risk parsers. Run the
  narrow supported format path, constrain resources, and contain failures.
- Downloads require the same authorization as metadata. An opaque ID or
  encrypted-looking URL is not access control.
- Validate MIME, signature, extension, and domain intent as separate facts;
  none alone proves safe content.

## Updates and operational authority

Updates execute code and therefore deserve the strongest available integrity
boundary. Verify manifest/artifact agreement before activation; bind build ID,
hash, target, and generation. The launcher alone owns the active-version
pointer and rollback decision. The application may stage and request an
activation, but must not create a second activation truth.

Host tools, backup download, HTTPS renewal, incident archives, and update
control require the appropriate administrative responsibility. They must use
narrow argument schemas, avoid general shell evaluation, and record a redacted
audit summary after success.

## Secret and diagnostic discipline

Secrets include session tokens, provider keys, certificate private keys,
password/PIN material, signed download capabilities, and sensitive content.
They must not be copied into source, client bundles, audit entries, Incident
context, process logs, test fixtures, or error messages.

Incident grouping needs enough context to diagnose a failure, not the whole
request. Prefer stable operation labels, build ID, environment, actor ID where
appropriate, entity IDs, and state/revision summaries. Redact bodies, prompts,
attachments, tokens, and filesystem content. Audit answers who performed which
administrative operation; it is not a forensic dump.

## Security review for a change

For every new boundary, answer:

1. What untrusted values enter, and where are shape and semantics validated?
2. Which Actor/authority permits the consequence, through which Facade path?
3. Can a stale response, actor switch, replay, or duplicate request change the
   result?
4. What persists on the server and client, and what happens on logout/purge?
5. Can logs, Incidents, audit, or AI calls disclose secrets or content?
6. Does the change expand network origins, executable artifacts, file parsing,
   raw HTML, native code, or host-command capability?
7. Which adversarial test demonstrates that the boundary rejects misuse?

Do not add a generic “security middleware” as a substitute for these answers.
The important controls are owned by the domain boundary where misuse becomes
meaningful.
