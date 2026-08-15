# Privacy and data lifecycle

ClassApp stores school-community content, learning activity, administrative
actions, AI conversations, local reading choices, and operational diagnostics.
Its privacy model must be expressed as ownership and lifecycle, not as a vague
promise to “delete user data.” Server truth, offline replicas, exports, logs,
backups, and provider-side data have different owners and erasure mechanics.

## Data classes

| Class                   | Examples                                              | Lifecycle rule                                                     |
| ----------------------- | ----------------------------------------------------- | ------------------------------------------------------------------ |
| identity                | user profile, role, session, client association       | server-owned; deactivate and purge are distinct                    |
| community truth         | memberships, posts, conversations, articles           | domain-owned; visibility and authorship survive by explicit policy |
| user decisions          | drafts, read watermarks, pins, retention claims       | preserve offline intent; merge by declared algebra                 |
| derived materialization | snapshots, coverage, rendered bundles, indexes        | reconstructible; evict or rebuild safely                           |
| AI data                 | conversations, workspace files, usage, billing ledger | separate content, secret, usage, and money lifecycles              |
| operational evidence    | audit, Incident details, logs, backups                | minimum useful detail; bounded access and retention                |

“Cached” does not mean disposable. A local draft is a user-authored fact; a
downloaded article bundle is usually a reconstructible materialization. The
schema and purge paths must preserve that distinction.

## Lifecycle states

```text
collect/create → validate → publish/materialize → retain/evict → archive/purge
```

Every new persistent datum must declare:

- business purpose and authoritative owner;
- subject/tenant key and visibility projection;
- server truth, local decision, or derived replica classification;
- retention/eviction condition;
- export, backup, and Incident/log exposure;
- deactivate and irreversible-purge behavior;
- whether downstream/provider copies exist.

If these answers are absent, the data model is incomplete.

## Deactivation is not purge

Deactivation prevents future participation while preserving referential and
community history needed by other people. Purge is an explicit destructive
orchestration across every owning Service. No single Users table deletion can
prove erasure.

```text
purge(user U) complete
⇒ every registered owner processed U
 ∧ authentication is invalidated
 ∧ no active projection exposes U-private data
 ∧ unavoidable retained references follow a documented policy
```

When a new Service stores user-bound state, it must implement or explicitly
reject purge semantics and be added to the central orchestration. Use an
ordered transaction where server-owned facts can be removed atomically. For
external workspaces or files, design idempotent cleanup and startup
reconciliation; do not hold SQLite open during slow filesystem/provider work.

## Offline copies and logout

The server cannot retroactively erase bytes from a disconnected device. The
honest guarantee is:

- current sessions cease receiving data after authority/session revocation;
- reconnect recovery removes objects no longer visible;
- logout detaches actor-bound in-memory state immediately;
- local purge/tombstone protocols remove known persistent projections;
- reconstructible caches remain subject to quota and retention policy;
- irrecoverable offline decisions are not deleted merely to simplify cleanup.

Document residual-risk windows. Never claim synchronous global erasure when a
device may remain offline. Actor IDs must namespace any local state that can
survive a session; otherwise one shared browser can disclose the last user's
data to the next.

## Visibility changes

Membership removal, authority change, conversation access change, and content
withdrawal are revocations, not ordinary updates. A revocation needs a client
repair path even if the original event was missed:

```text
reconnect → re-establish actor/access snapshot → purge denied projections
          → repair coverage → replay safe queued events
```

Do not retain content because its metadata was locally pinned unless the domain
explicitly allows possession after revocation. Retention is a materialization
preference, not an authorization grant.

## AI and external processing

Before sending data to an AI provider, classify what is necessary for the
requested task. Do not silently attach unrelated community history, audit data,
secrets, or full workspaces. Provider API keys are server secrets; usage and
billing records should identify cost without copying prompts or responses.

Workspace ZIPs and catalogs are user content. Apply size/path constraints and
keep catalog names separate from opaque storage mechanics. Deleting an AI
conversation, workspace, usage row, or billing entry are different operations;
their relationships must be explicit rather than inferred by filename.

## Audit, Incidents, and logs

Operational evidence has a legitimate purpose but can become a shadow content
store. Record identifiers, transition summaries, correlation, build, and
diagnostic state. Avoid request bodies, tokens, prompts, article text, uploaded
files, and private keys. Limit detail access to operational responsibility.

Incident grouping may retain only a bounded sample while still returning a
public Incident ID for later occurrences. Log archives are privileged exports;
creation and download must be authorized and should not broaden what ordinary
logs contain.

## Backups and exports

A backup is another copy of all included data, outside ordinary row-level purge
and retention. Backup creation, download, storage location, restoration, and
retirement form one operational policy. Do not promise that a user purge edits
historical backups in place. Instead document backup retention and ensure that
restoration is followed by current migration, revocation, and reconciliation
rules where applicable.

Exports must be generated from an authorized projection, not from raw tables or
workspace directories exposed for convenience. Temporary artifacts need unique
ownership, bounded lifetime, and cleanup that cannot mask the original error.

## Schema review checklist

For each new table, IndexedDB store, file, event payload, audit detail, or
Incident field:

1. Label it authoritative fact, user decision, projection, or diagnostic.
2. Name its owner and identity/tenant key.
3. Define create, overwrite/merge, eviction, revocation, and purge.
4. Add it to quota, logout, actor-switch, backup, and user-removal analysis.
5. Verify that logs and errors expose only necessary metadata.
6. Test purge/recovery with failures between owners, not only the happy path.

Privacy is preserved by complete ownership accounting. A UI delete button or a
foreign-key cascade is evidence for only one part of that accounting.
