# Resource authorization

ClassApp splits social access into two resource classes. The split is a product
constraint, not a generic IAM framework: ownerless catalog objects must remain
immutable and shareable without persisting every transient discovery set, while
playlists and booklists are mutable collections whose authority comes from
principal relationships.

Media and articles are separate domains. They share the **access subsystem**
(grant algebra, bindings, materialization, HMAC capabilities) and similar UI
shape. They do not share storage. A booklist is not a `media_lists` row.

## Resource classes

**Ownerless objective resources** — tracks and articles. They have no owner
field. A client may read one only by presenting a capability token the server
can verify statelessly, or by recovering an equivalent token from a still-valid
containing collection. Search results, queues, playlists, and booklists sign
each contained object when they return a snapshot. The server does not persist
search result sets.

**Owned resources** — playlists, booklists, and a user's queue. They have no
single `owner` column. Authority is a set of access bindings keyed by
`(resource_kind × resource_id × principal)`, where a principal is a user or a
group and `resource_kind` is an opaque domain string. There is no addressable
access object ID. Effective authority is the union of every live path from the
current user, including group memberships.

```ts
type AccessGrant =
  | { mode: "owner" }
  | { mode: "readwrite" | "read"; shareable: boolean };
```

Only a shareable grant (or owner) may issue a **restricted subset** of itself.
Issuing is not the same as flag coverage: a non-shareable `readwrite` grant is
stronger than `read` for local mutation, but cannot grant anything. Mixed paths
such as shareable-read ∪ held-write produce both `read` and `write` without
synthesizing `shareWrite`.

Favoriting or bookmarking is a preference overlay. It does not create a
personal binding. After leaving a group, access remains only if another live
path still exists.

Queue sharing is a media product rule: the media facade never offers grant on
a queue. `AccessService` itself does not special-case queue.

## Capability tokens

Tokens are `c1.<payload>.<hmac>` over a canonical signing input (version, kind,
id, ops, times, source). Object `kind` and collection `kind` are opaque
strings; HMAC verification does not enumerate playlist/booklist/track/article.
Search tokens last 24 hours; collection-derived tokens last 30 days. Possession
of an unexpired token authorizes `read` of that object. Leaving a group does
not immediately revoke already-issued ownerless tokens; they expire. Owned-list
access is revoked immediately through rematerialization.

Capability source is generic:

```ts
type CapabilitySource =
  | { type: "search" }
  | { type: "collection"; kind: string; id: string; revision?: number }
  | { type: "recovery"; kind: string; id: string };
```

## Materialized effective access

`access_effective` is a per-user materialized view of owned-resource flags plus
provenance (which principal bindings contributed). The happy path reads that
row. On miss or stale denial, `AccessService` recomputes from live bindings and
rewrites the row so the UI does not have to rediscover the granting location.

Ownerless recovery asks an injected domain port which collections currently
contain the object, then checks whether the user can still read one of those
collections, signs a `recovery` capability, and stores possession. Media
answers for tracks (playlist/queue membership); articles answer for articles
(booklist membership). Access SQL does not join `media_lists` or
`booklist_items`.

Fine-grained checks (`canDoSomething`) read the corresponding flag column
(`can_read`, `can_write`, `can_own`, `can_share_*`) rather than walking the
graph again.

Invalidation happens on grant, revoke, group join/leave/delete, and user purge.
Group membership changes rematerialize only the lists bound to that group for
that user.

## Discovery aggregations

Music Center and Article Center expose:

- recently played / recently read
- favorites / bookmarks that are still reachable
- owned or shared lists (playlists / booklists)

They do not expose a global “all music” or “all articles” collection. Group
chat article views open that group's booklist via `group_booklists`. Existing
group-chat articles migrated in schema v27 as ownerless objects inside a
group-owned booklist. Articles do not store an origin group column; `group_id`
on the article wire DTO is a view projection from that association.

## Module owners

| Concern | Owner |
| --- | --- |
| Grant algebra, subset, union, flags | `shared/access` |
| HMAC sign/verify over opaque kinds | `CapabilityService` |
| Bindings, materialization, possession, recovery orchestration | `AccessService` |
| Track containment for recovery | `server/data/media` (`collectionsContainingTrack`) |
| Article containment and group association | `server/data/booklists` (`group_booklists`) |
| Playlist/queue snapshots and track signing | `MediaPlaylistService` |
| Booklist snapshots and article signing | `BooklistService` |
| Actor paths | `MediaActorFacade`, `ArticleActorFacade` |
| Client capability cache | `client/interact/capabilities.ts` |

Authorization failures are `AuthorizationError` domain outcomes (`denied`,
`invalid_capability`, `expired_capability`, `not_found`), not ad-hoc handler
strings.

This is a **narrow resource capability**, not a general policy language. Roles,
features, mute, and client admission remain independent Facade checks. See
[authority, validation, and audit](../foundations/authority-validation-audit.md).
