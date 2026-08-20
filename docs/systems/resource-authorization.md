# Resource authorization

The access subsystem has **two mechanisms**. They are not two classes of one
authorize API. Media and articles are separate domains; they share this
subsystem and similar UI shape, not storage. A booklist is not a `media_lists`
row.

## Owned access

Playlists, booklists, and a user's queue have no single `owner` column.
Authority is a set of access bindings keyed by
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

`AccessService` owns this mechanism. It does not sign tokens, store possession,
or treat favorites as access.

Queue sharing is a media product rule: the media facade never offers grant on
a queue. `AccessService` does not special-case queue.

## Ownerless capabilities

Tracks and articles have **no owner and no access bindings**. Possession of an
unexpired HMAC token **is** authorization. There is nothing to rematerialize on
the object. `OwnerlessCapabilityService` verifies the presented or cached
token and stops there.

Search results, queues, playlists, and booklists sign each contained object
when they return a snapshot. The server does not persist search result sets.
Search tokens last 24 hours; collection-derived tokens last 30 days. Leaving a
group does not immediately revoke already-issued ownerless tokens; they expire.
Owned-list access is revoked immediately through rematerialization.

Tokens are `c1.<payload>.<hmac>` over a canonical signing input (version, kind,
id, ops, times, source). Object `kind` and collection `kind` are opaque
strings; HMAC verification does not enumerate playlist/booklist/track/article.

```ts
type CapabilitySource =
  | { type: "search" }
  | { type: "collection"; kind: string; id: string; revision?: number }
  | { type: "recovery"; kind: string; id: string };
```

Recovery is composition, not ownerless access. If no valid token is held, the
capability service asks an injected domain port which **owned collections**
currently contain the object, then `AccessService.peek` whether the user can
still **read** one of those collections, and only then mints a `recovery`
token. Media answers for tracks (playlist/queue membership); articles answer
for articles (booklist membership). Access SQL does not join `media_lists` or
`booklist_items`.

## Materialized effective access

`access_effective` is a per-user materialized view of **owned-resource** flags
plus provenance (which principal bindings contributed). The happy path reads
that row. On miss or stale denial, `AccessService` recomputes from live
bindings and rewrites the row so the UI does not have to rediscover the
granting location.

Fine-grained checks (`canDoSomething`) read the corresponding flag column
(`can_read`, `can_write`, `can_own`, `can_share_*`) rather than walking the
graph again.

Invalidation happens on grant, revoke, group join/leave/delete, and user purge.
Group membership changes rematerialize only the lists bound to that group for
that user.

## Preference overlay

Favoriting or bookmarking is not authorization. It does not create a personal
binding and does not live on `AccessService`. After leaving a group, owned
access remains only if another live path still exists. Centers filter recents
and favorites by current reachability: owned lists via `AccessService.peek`,
ownerless objects via a still-valid token (or recovery through a readable
collection).

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
| Owned bindings and materialization | `AccessService` |
| Ownerless tokens, possession cache, recovery composition | `OwnerlessCapabilityService` |
| Preference overlay | `server/data/preferences` |
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
