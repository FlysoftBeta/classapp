# Authority, validation, and audit

Authority is the answer to “is this actor allowed to take this business path
now?” It is not synonymous with roles, feature flags, group membership, quota,
or client trust. Those are independent facts that a public Facade composes.

## Why authority lives in Facades

ClassApp deliberately does not implement a general capability *policy language*
for roles, features, mute, or client admission. Those remain independent
Facade checks. Resource access for ownerless catalog objects and owned lists
uses a **narrow** capability/binding model described in
[resource authorization](../systems/resource-authorization.md). That model is
not a substitute for the dimensions below.

Facades therefore state the rule close to the public operation:

```text
require authenticated Actor
require product feature
load objective group/article/post facts
accept owner path OR named moderator path
invoke objective Service mechanism
audit the administrative path
```

When several roles legitimately satisfy a decision, give the decision a domain
name and spell out its alternatives. Do not hide meaning in
`requireAnyRole([a,b,c])` scattered through the code.

## Independent authority dimensions

- authentication: which stable user is bound to the request;
- client admission: whether the physical/logical device may proceed;
- account state: deactivated, banned, muted, locked;
- product feature: AI, article creation, group creation, and similar access;
- administrative responsibility: named roles;
- relationship: owner, group member, visible peer, creator;
- resource state: exists, immutable, already deleted, pending;
- quota/reservation: whether an expensive operation can be funded.

Do not compress these into one “permission” object. Their lifetimes, owners,
failure messages, and audit requirements differ.

## Administrative roles

`administrator` admits the user to the management workbench but grants no
sensitive operation alone. Specialized roles are:

| Role                         | Responsibility                                                   |
| ---------------------------- | ---------------------------------------------------------------- |
| `root`                       | role assignment and recovery of administrative governance        |
| `operations`                 | incidents, certificates, backups, updates, rollback              |
| `feature_manager`            | product features, AI plans, quota, top-ups                       |
| `operations_assistant`       | low-risk lock settings and convenience tools                     |
| `access_manager`             | clients, pending identities, user admission                      |
| `community_manager`          | moderation, credentials, group creation, direct content removal  |
| `advanced_community_manager` | deletion/profile/group changes, forced membership, announcements |

Every specialized role requires `administrator`.
`advanced_community_manager` requires `community_manager`. `root` controls role
assignment but does not implicitly possess unrelated operational powers. The
last active root cannot be removed or deactivated.

Roles and product features are separate on the wire and in reasoning. SQLite
may encode features as a bitset, but bit positions are private to Data.

## Validation stages

Validation is layered by responsibility:

1. **Frame validation** — protocol version, kind, request ID, actor slot, action
   name shape, argument array bounds.
2. **Action contract validation** — correlated Zod schema for arguments and
   output. This protects both server and client from drift.
3. **Semantic input validation** — normalized handles, cursor combinations,
   mutually exclusive update fields, sizes, formats, and URL policy.
4. **Authority** — Actor may take this path.
5. **Domain invariant** — the requested transition is objectively valid.
6. **Persistence constraint** — uniqueness, foreign keys, checks, and triggers
   provide final structural defense.

Do not rely on a UI control being hidden. Do not use a database constraint as a
normal public error message when the conflict can be detected semantically.
Conversely, keep the database constraint as defense against races.

Malformed requests and server output mismatches are contract violations. They
are not ordinary business failures and should be captured as Incidents.

## Client authority projection

The client may receive semantic booleans such as `can_post` and `can_leave` to
render controls and work offline. These are actor-specific server conclusions,
stored under that actor. They never authorize a server mutation; the Facade
rechecks every command. Group `can_post` currently means “unmuted, and
`administrator` when the group is admin-only,” matching the post Facade.

Do not send raw roles, bitsets, or enough internal policy state so the client can
reimplement the decision. Send the presentation consequence.

## Audit

Audit records successful administrative decisions, not attempts and not generic
errors. The record belongs in the same transaction as the mutation whenever
possible.

Minimum fields:

- actor stable ID;
- semantic action name;
- target kind and stable ID or target set;
- server timestamp;
- safe, bounded summary of changed fields or parameters.

Never copy PINs, session tokens, provider tokens, file contents, post/article
bodies, full AI prompts, or other secrets into audit details. Incidents and audit
serve different purposes: an Incident diagnoses failure; audit establishes who
successfully exercised authority.

Bulk changes are one business command and should have one server-side atomic
path and coherent audit entry. A client `Promise.all` over single-target admin
Actions produces partial success, incoherent audit, and unbounded concurrency.

## Review checklist

- Is the public rule visible at the Facade?
- Are feature, role, relationship, quota, and account state kept distinct?
- Does the Service remain usable by legitimate alternative paths without an
  `isAdmin` bypass?
- Is validation performed at the correct stage and output validated too?
- Is the client projection actor-scoped and non-authoritative?
- Does a successful administrative mutation produce a safe audit entry in the
  same unit of work?
- Can the last root or another recovery authority accidentally disappear?
