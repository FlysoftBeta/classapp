# Community, conversations, posts, and articles

A Group is a social aggregation of people, discovery context, authority
relationship, conversation, and content boundary. It is not merely a chat room
or a row that contains members.

## Group semantics

Groups may have:

- stable ID and mutable public handle/name;
- a conversation identity derived as `group:<id>`;
- discoverability through search or a parent Group;
- a password on the join path;
- hidden member list and per-member self-hiding;
- administrator-only posting (`can_post` uses the `administrator` role, the
  same gate as the post Facade; it is not `community_manager`);
- no-leave policy;
- special `wild` or `announcement` type;
- Articles, Posts, and DM establishment relationships.

Joining records/verifies the route by which membership is legitimate:

- search requires discoverable target;
- parent discovery requires membership in the named parent and target linkage;
- admin/system are explicit trusted server paths.

Special groups express community-wide aggregation. Only one group of each
special type is active. Announcement membership is maintained for active users.
Ordinary empty groups may be deleted; system groups cannot.

## Conversation identity

There is no generic conversation source-of-truth table. A conversation exists
because a Group or DM exists.

```text
group conversation = group:<group ID>
DM conversation    = dm:<smaller peer ID>:<larger peer ID>
```

A DM is established with its first Post in one transaction. Initial validity is
proven by a Group in which both peers have the required visible relationship.
The durable DM row preserves historical legitimacy if membership changes later.
The client never invents an established DM offline.

## Posts

Post identity and order are immutable:

```text
(UUID, conv_id, global sequence)
```

Each current row has a revision. Edit and delete update the row revision;
deletion replaces the body with a tombstone and keeps UUID/sequence so replies,
read watermarks, cache merges, and audit context remain valid.

The Facade selects a legitimate path:

- author create/edit/delete;
- group membership and posting policy;
- muted/feature/account constraints;
- moderator direct removal.

`PostService` enforces objective content/revision/state invariants and emits
complete authoritative versions. It does not take a generic `isAdmin` flag.

Posts store author/reply user IDs. Presentation user metadata travels as a
deduplicated side bundle and is normalized into `domain_users`. The same
envelope applies to DM peers, Group membership rows, Articles, and the admin
Audit/Client read models: domain rows carry stable user IDs, while a sibling
`users` array carries each required public identity once. Do not copy mutable
handles into historical content, membership, or operational rows.

## Articles

Articles are ownerless immutable objects. `origin_group_id` records where they
were published; it is not an ACL. Access is a signed capability issued when a
booklist, recent/favorite aggregation, or other legitimate snapshot includes
the article. Booklists are owned collections with principal access bindings.
A group chat's article view opens that group's booklist. Schema v27 migrated
existing group-chat articles as ownerless booklist items, not owned resources.

Creation still requires group membership and posting policy. Objective
insertion/render metadata lives in `ArticleService`/Data. Bookmarks and resume
state are user preferences and do not create independent access. See
[resource authorization](./resource-authorization.md).

Providers are currently:

- text: immutable UTF-16-offset segments of at most 10,000 code units;
- bundle: immutable source/render archive identity and item count.

The Article wire entity contains `user_id`, never `username` or `handle`.
Client presentation joins its author from `domain_users`; the persisted Article
core is a positive field list rather than an `Omit` blacklist, so adding a new
wire presentation field cannot silently expand the immutable core.

Article Center aggregations are recents, favorites, and reachable booklists,
not a global “all articles” collection. Booklist pages are finite snapshots.
Never restore OFFSET/total merely for UI convenience.

## Cross-domain effects

Membership changes affect:

- conversation directory/access;
- event subscriptions;
- Article visibility/list projections;
- posting authority;
- member-list snapshots;
- pending local proposals (which become dormant);
- offline retention rematerialization eligibility.

Therefore a membership feature is cross-stack even if its SQL update is one
row. The Facade/Service workflow must publish conversation refresh and remote
resubscribe after commit, while reconnect snapshots remain the durable repair.

Profile changes affect normalized `domain_users`, not immutable content.
Deactivation removes memberships and credentials but preserves historical
identity/content. Purge asks every owning Service to remove per-user state and
side effects before deleting the identity.

## Privacy and moderation

Member-list hiding is a domain projection, not CSS. Non-authorized clients
receive an explicitly hidden snapshot rather than the full list with hidden UI.
Per-member self-hiding is interpreted relative to the viewer.

Moderation is contextual. The administration workbench intentionally avoids a
universal “read all Posts” surveillance page. Direct removal authority does not
imply unrestricted content browsing.

## Change analysis

For any Group/content change trace:

1. stable server identity and SQL constraints;
2. actor paths in the Facade;
3. objective Service invariant;
4. transaction and audit;
5. event channel/subscription change;
6. Action/event DTO and normalization;
7. actor access/snapshot/coverage effect;
8. offline proposal and retention behavior;
9. Infini cursor/order behavior;
10. deactivation/purge consequence.
