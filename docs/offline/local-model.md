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

| Family                                                                                                      | Purpose                                                 |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `domain_groups`, `domain_dms`, `domain_posts`, `domain_articles`, `domain_article_segments`, `domain_users` | shared objective projection                             |
| `domain_me`                                                                                                 | locally known authenticated users and session bootstrap |
| `domain_me_access`                                                                                          | actor access, capability and snapshot projections       |
| `domain_me_conv_state`                                                                                      | read/pin/mute/draft base + proposal                     |
| `domain_me_article_state`                                                                                   | bookmark/resume/furthest base + proposal                |
| `domain_me_state`                                                                                           | versioned user settings                                 |
| `domain_sync`                                                                                               | coverage/revision/snapshot proofs                       |
| `domain_save`                                                                                               | per-claimant retention intent and materialization state |
| `files`, `file_heads`                                                                                       | extent generations                                      |
| `globals`                                                                                                   | application initialization markers only                 |
| `shell_bundles`, `shell_kv`                                                                                 | independently owned Shell bootstrap stores              |

The exact schema may change. The classifications and ownership rules are the
stable design.

## Identity rules

- Use stable server IDs for keys and references.
- Handles are mutable lookup labels. Client handle indexes are non-unique
  because stale reconstructible rows must not poison a newer identity that
  legitimately reuses a handle.
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
efficiency. `client/interact` splits them before persistence. Every response and
event for the same entity must use the same normalization/merge entry point.

React receives a presentation DTO assembled from normalized rows. It must not
persist aggregate screens, because duplicated metadata then drifts and one
mutable profile change can make an “immutable” object appear changed.

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
