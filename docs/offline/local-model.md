# Local data model and ownership

The browser database is a disposable materialized projection of server facts,
a durable carrier for unsynchronized user decisions, a materialization store
for offline bodies, and a production bundle store. These roles must stay
distinguishable.

## Three classes of domain fact

### Objective entities

An objective entity is the same for every actor who may see it: group/DM core,
Post current version, Article core, public user identity, immutable article
segments and document resources.

Store one copy per device. Use stable IDs and foreign IDs; do not denormalize
mutable usernames/handles into historical Posts or immutable Article cores.
Presentation reads join `domain_users` in the same readonly transaction.

### Actor projections

Actor projections answer what server policy concluded for a particular user:

- access to a conversation/article;
- `can_post`, `can_leave`, and similar presentation consequences;
- directory/list membership and sort cursor;
- group member snapshot visible to that actor.

They are keyed by `me_id`. Data fetched for actor A must never authorize or
materialize a view for actor B. Losing access removes the actor projection, not
the shared objective entity.

### User decisions

User decisions are independently writable offline. Each field stores a
canonical server base and an optional local proposal:

```ts
type Assignment<T> = {
  base: { value: T; updated_at: number };
  proposal: null | {
    value: T;
    updated_at: number;
    operation_id: string;
  };
};
```

Do not combine several independently mergeable settings under one version. A
theme update must not overwrite a newer DND proposal merely because both live
in “settings.”

## Current store families

| Family                                                                                                      | Purpose                                                                             |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `domain_groups`, `domain_dms`, `domain_posts`, `domain_articles`, `domain_article_segments`, `domain_users` | shared objective projection                                                         |
| `domain_me`                                                                                                 | locally known authenticated users, session bootstrap, and last confirmed gate state |
| `domain_me_access`                                                                                          | actor access, capability and snapshot projections                                   |
| `domain_me_conv_state`                                                                                      | read/pin/mute/draft base + proposal                                                 |
| `domain_me_article_state`                                                                                   | bookmark/resume/furthest base + proposal                                            |
| `domain_me_state`                                                                                           | versioned user settings                                                             |
| `domain_sync`                                                                                               | coverage/revision/snapshot proofs                                                   |
| `domain_save`                                                                                               | per-claimant retention intent and materialization state                             |
| `files`, `file_heads`                                                                                       | extent generations                                                                  |
| `globals`                                                                                                   | application initialization markers only                                             |
| `shell_bundles`, `shell_kv`                                                                                 | independently owned Shell bootstrap stores                                          |

The exact schema may change. The classifications and ownership rules are the
stable design.

## Identity rules

- Use stable server IDs for keys and references.
- Handles are mutable lookup labels, not client lookup keys. Objective stores
  have no handle indexes; stale reconstructible rows therefore cannot poison a
  newer identity that legitimately reuses a handle.
- `conv_id` is the canonical conversation identity:
  `group:<group-id>` or ordered `dm:<peer-a>:<peer-b>`.
- Post `(id, conv_id, sequence)` is immutable; current content/tombstone changes
  by revision.
- Article body/provider identity and segments are immutable. Title and author
  presentation metadata must be classified deliberately rather than included
  in a broad deep-equality check.
- Content-addressed bundle resources use SHA-256 IDs of raw content.

## Normalization rules

Wire DTOs may aggregate objective, actor, and decision fields for transport
efficiency, but domain entities carry only stable user IDs. APIs and events put
the public identities already justified by those visible entities in one
deduplicated `users` side bundle. The server resolves every side bundle through
the shared ID-based helper; `client/interact` merges it through the shared
`domain_users` path before storing or presenting the entities. This avoids a
second user-directory authorization question and keeps every response/event on
the same normalization path. Each identity carries a monotonic profile revision;
older responses cannot overwrite a newer cached handle or username, and equal
revision conflicts are treated as contract violations.

React receives a presentation DTO assembled from normalized rows. It must not
persist aggregate screens, because duplicated metadata then drifts and one
mutable profile change can make an “immutable” object appear changed.

The active `domain_me` row also retains the server's last confirmed client
lock, effective per-user application disable state, and global system-lock
flag. Offline warm start restores that gate instead of assuming an unlocked
application. The effective disable state is stored separately from the global
flag because administrators may remain allowed through a system lock. These
values are reconstructible projections: they never authorize server work and
an online application-state probe replaces them.

A local lock is safety-monotonic: it takes effect and becomes durable without
waiting for transport. The Konami lock itself belongs to the server-side Client
record, while this durable carrier is the user-keyed `domain_me` row; a local
proposal therefore exists only while a session binds that user to this client.
The row stores it through the normal `base + proposal + operation_id`
assignment model until reconnect sends it to the server. Only the response for
the proposal it sent may acknowledge that operation; a newer proposal survives
an older response. Reconnect flushes the proposal before probing application
state, and a server-unlocked base cannot override the proposal.

An authenticated-session unlock uses the same offline proposal path: it leaves
the client lock immediately, while any separately cached effective user/system
disable state still gates the App. Reconnect later confirms the unlock with the
server. The anonymous Konami gate has no `domain_me` row to carry a proposal,
so it cannot use that path: `sessionController` sends `patchClientMe(false)`
directly, keeps the lock screen until the response, and lets the following
authoritative probe choose login or App.

Application schema v3 adds these fields to `domain_me`. Application schema v4
also removes the obsolete Group/User handle indexes and marks legacy cached
user rows as pre-versioned. The v2-to-v4 upgrade
updates existing user rows and the semantic marker in one versionchange
transaction without rebuilding other application stores, so drafts, pending
proposals, retention choices, cached content, and Shell stores survive. Because
v2 did not retain gate evidence, migrated rows initially use the prior
unlocked-start behavior; the first successful online state probe replaces those
defaults. The v3-to-v4 upgrade only removes the indexes and advances the
semantic marker. Unknown or yanked semantic versions still use the reconstructible
application-store rebuild path. The existing physical-version retry handles a
concurrent Shell upgrade, and the standard blocked-upgrade Incident/UX remains
the failure boundary.

Missing objective presentation metadata degrades neutrally and is repairable by
a later side bundle. It must not grant access or manufacture identity.

## Global state prohibition

Database globals are initialization hints, not live operation context. An
asynchronous operation captures:

```text
ActorContext = (stable user ID, authentication epoch)
```

All repositories and helpers are actor-bound from that point. If the epoch is
no longer current, actor-specific results are discarded/cancelled. A genuinely
objective row may still be reusable only after its normal immutability/revision
validation.

The current proxy that captures an actor for small one-shot repository calls is
a migration convenience. Multi-step operations must retain one explicit
context; do not add deeper implicit active-user reads.

## Schema evolution

The Shell and application share a physical database but own disjoint stores and
semantic version markers. Physical IDB version numbers are coordination tokens,
not semantic versions.

Reconstructible application schemas may be declared yanked and rebuilt in one
versionchange transaction. Do not write compatibility readers, dual writes, or
row-by-row migrations for data the server can reproduce. Preserve Shell stores
and pending irreplaceable decisions according to an explicit cutover plan.

Every schema change must specify:

- semantic app/Shell version;
- exact owned store set;
- reconstructible versus preserved data;
- version-race behavior with another tab/owner;
- blocked upgrade UX;
- Chrome 70 E2E migration case;
- removal of old readers and writers.

## Projection availability

The online UI should remain usable when projection persistence fails. A remote
read result can be rendered directly after reporting the cache error, provided
no actor/access invariant is bypassed. Do not put cache success on the critical
path of a valid server response.

User decision writes are different: acknowledgement requires durable local
proposal persistence (and later server acknowledgement), because otherwise the
application would lie about preserving offline intent.
