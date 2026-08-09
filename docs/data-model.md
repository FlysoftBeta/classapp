# ClassApp data model v16

## Invariants

### Conversation identity

`conv_id` is the only conversation key used by posts, user state, events, and
the browser cache. It is a tagged string:

- `group:<group id>` for a group;
- `dm:<peer a>:<peer b>` for a direct message, where `peer_a < peer_b` by
  Unicode code-point ordering.

`groups` and `dms` are the source of truth for conversation existence. There
is deliberately no generic conversations table whose rows could drift away
from the type-specific rows.

Creating a DM and its first post is one transaction. The creation proof is a
group for which both users are members and neither membership is hidden from
the other. Once created, the `dms` row is the durable proof that the
conversation is valid; later group membership changes do not rewrite history.

Joining a group always records a server-verifiable route:

- `search`: the target group must have `discoverable = 1`;
- `group`: the caller must be a visible member of the supplied source group,
  and the target must name that source as its parent;
- `admin` and `system`: trusted server-side paths only.

### Posts

Posts have an immutable UUID and an explicit, monotonically increasing
`sequence`. They contain `conv_id`, `author_id`, `brief`, `content_json`, an
optional reply UUID, and timestamps. Target-specific columns do not exist.

Text reuses `brief` as its body and stores
`{"type":"text","text_same_as_brief":true}`. Structured messages keep a
search/list brief and store their full payload in `content_json`.

Deleting a post is an update, never a row deletion. Its body becomes exactly
`{"type":"deleted"}`, its brief becomes empty, and `deleted_at` is set. This
applies equally to authors, administrators, and user-lifecycle cleanup. The
UUID and sequence remain valid cache and read-watermark anchors.

### Articles

`articles` stores only identity, title, owning group, provider metadata, and
timestamps. `provider_json` is validated JSON:

- text: `{"type":"text","words":N,"chunks":N}`;
- blob: `{"type":"blob","file_name":"...",...}` (`file_name` is the blob
  service identity; size/MIME/name are optional provider details).

Text is split once on creation into `text_article_segments`. Each segment has
an integer index, absolute reader offset, stored length, and at most
10,000 JavaScript string offset units (UTF-16 code units, matching client reader
offsets). A boundary backs up one unit rather than split a Unicode surrogate
pair. Segment lookup uses the indexed absolute `start_offset`, so variable safe
boundaries remain independent of the
requested scroll depth. The client may do presentation paragraphing inside a
returned hard segment but must not treat it as a server storage boundary.

### Browser cache

IndexedDB mirrors server entities rather than serializing aggregate screens:

- `domain_conversations`, keyed by user and `conv_id`;
- `domain_posts`, keyed by user and post UUID, indexed by conversation and
  sequence;
- `domain_articles`, keyed by user and article UUID;
- `domain_article_state`, keyed by user and article UUID, for bookmark and
  reading state only;
- `domain_article_segments`, keyed by user, article UUID, and absolute start
  offset.

Server-owned entities are reconciled by identity and server sequence. Local
user choices (drafts, retention, read watermarks, bookmarks, and progress) keep
their timestamped outbox records in the persistent resource store. Cached
entity rows carry retention class, size estimate, and last-touch time so quota
pressure can evict cache rows without deleting explicit offline downloads.

IndexedDB v3 is a hard cache boundary. Opening any older version discards the
database and recreates it; cache data is never migrated. IDB values are plain
structured-clone objects or `ArrayBuffer` values. Blob values are forbidden.

## Server schema

The conversation and article domain is deliberately small and normalized:

| Table                   | Identity                                     | Server-owned state                                                                       |
| ----------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `groups`                | `id`, unique `conv_id`                       | name/handle, discovery and join policy, type flags, parent group, post revision          |
| `group_members`         | `(group_id, user_id)`                        | join time and member visibility (`hide_self`)                                            |
| `dms`                   | ordered `(peer_a, peer_b)`, unique `conv_id` | proof group, creation time, post revision                                                |
| `posts`                 | immutable UUID plus monotonic `sequence`     | `conv_id`, current row revision, author, brief, structured content, reply and timestamps |
| `convs_user`            | `(user_id, conv_id)`                         | read anchor, pin/mute, draft, and independent timestamps                                 |
| `articles`              | immutable UUID                               | group, title, author and provider JSON                                                   |
| `text_article_segments` | `(article_id, segment_index)`                | immutable absolute offset, length and content                                            |

`posts.conv_id` and `convs_user.conv_id` cannot be ordinary foreign keys
because their target is the union of `groups` and `dms`. Insert/update triggers
enforce that union reference. Identity triggers prevent changing a post,
conversation, article, or article-segment identity after creation. Deleting an
entire source conversation may cascade its dependent history; deleting an
individual message always writes a tombstone.

The main access paths are indexed: posts by `(conv_id, sequence DESC)`, DMs by
each peer, memberships by user, articles by group/user and creation time, and
article segments by `(article_id, start_offset)`. Brief search has its own
index; richer search can be replaced with FTS later without changing the row
model.

### Establishment transactions

- Group membership is inserted only after its password and route proof pass.
  Search joins require the group to be discoverable. Discovery joins require
  the supplied source group to be visible to the caller and to match the
  target's parent.
- A new DM and its first post are one SQLite transaction. The server orders
  peer IDs, finds a group in which both members are mutually visible, records
  that group as the proof, inserts the DM, then inserts the post. A failure
  rolls back both rows.
- An existing DM remains valid even if its proof group later changes. The DM
  row, rather than a repeated membership calculation, is then the authority.

## Client consistency protocols

Consistency rules live in `client/data`; components and hooks consume resolved
entities and never implement timestamp/revision comparisons themselves.

### Conversation directory

The conversation list is an authoritative server snapshot of the source
tables plus the current user's `convs_user` projection. A `conv.updated` event
is only a low-latency hint and sidebar row; after reconnect the client fetches
the complete list, adds new source rows, and removes rows absent from that
snapshot. Post `revision` is not used to arbitrate group names, membership, or
user options.

The client never manufactures an established conversation. A temporary DM row
may be rendered while composing the first message, but it has revision zero
and is replaced only by the server-created `dms` projection.

### Posts: current-state revision protocol

Every group/DM owns a monotonically increasing post `revision`. Inserting a
post or changing its body/tombstone increments that source row and copies the
new revision onto the affected post. The revision describes the current post
state, not an append-only mutation log.

Catch-up is:

1. read cached `(conv_id, revision)` values;
2. request the user's authoritative revision list;
3. for each greater remote value, page current post rows where
   `cached_revision < post.revision <= awareness_revision`, ordered by
   revision, and advance the revision keyset cursor after each page;
4. merge by post UUID, accepting only an equal-or-higher row revision;
5. after all pages succeed, advance the cached conversation revision;
6. fetch the full conversation snapshot for metadata and removals.

If any page fails, step 5 does not run, so the next recovery retries the same
range. A concurrent mutation after the awareness snapshot is harmless: the
snapshot upper bound excludes it and the next awareness call includes it.
Updating a row that had not yet been paged moves it above that bound, also
deferring it without shifting the current keyset. A stale response cannot
resurrect an edited/deleted post because row merge compares revisions.

WebSocket create/update/delete events all carry the complete authoritative
Post row. The global data subscriber persists it even when that conversation
is not open; the active view subscriber only updates rendering. Event delivery
is not assumed durable, and no message queue/cursor is stored—the revision
protocol is the recovery mechanism. Since deletion is a row version, there is
no missing-middle inference and no synthetic deletion based on page absence.

### Articles and segments

Article metadata and bodies are immutable. Re-reading the same identity is a
cache hit; receiving different immutable core fields for the same UUID is a
consistency error rather than a merge decision. Mutable bookmark and reading
fields are stored separately in `domain_article_state`.

Article list pages reconcile membership only over the page interval they
authoritatively cover. Create/delete events may refresh that list for latency,
but article bodies never need a revision scan. A segment cache key is
`(user, article_id, start_offset)`; a repeated write must be byte-for-byte the
same structured value. Text loading finds the greatest indexed
`start_offset <= requested_offset`, making access independent of scroll depth.

Blob articles may still reference the server blob service in `provider_json`,
but binary bodies are never persisted as IDB `Blob` values. Runtime bundles and
generic JSON resources are persisted as `ArrayBuffer`; a temporary in-memory
Blob may be created only when a browser API requires one.

### Assignment settings: device-clock LWW

Each independently assignable switch/value has one client record equivalent
to `{proposed, purpose, timestamp, acknowledgedTimestamp}`. `purpose` binds the
proposal to a semantic field so values from different settings cannot be
compared accidentally.

- A local write uses `max(Date.now(), previousTimestamp + 1)` and remains
  pending.
- The server applies the input only when its timestamp is greater than or
  equal to the stored timestamp, then always returns its canonical value and
  timestamp.
- The client keeps a strictly newer local proposal. Otherwise the returned
  server value wins; this intentionally makes the server win an exact tie.
- An older response cannot acknowledge or erase a newer local proposal.

This is used for mute, pin, bookmark, reader options, and other assignment-like
configuration. The accepted trade-off is that a device with a far-future wall
clock can dominate until real time catches up; server time is deliberately not
substituted for the requested device-time LWW rule.

### Unread/read position: grow-only sequence watermark

Read state is `{postId, sequence, timestamp}`. Both client and server choose the
greater `sequence`; a newer timestamp can win only when sequences are equal.
Thus offline/reordered requests can acknowledge the same point but can never
move unread state backward. Tombstoned posts retain UUID and sequence, so an
existing read anchor remains valid after deletion.

### Reconnect order and transaction boundaries

On connection recovery the client flushes pending assignment/draft/progress
records and materializes explicit offline policies, then performs post revision
catch-up and refreshes authoritative conversation/article lists before it
resumes relying on events. Each post conversation is
serialized through a per-key client/data lock around read-merge-write. IDB
transactions cover each normalized store replacement/upsert; a conversation
revision is advanced only after its post writes complete.

Download/retention preferences are local materialization policy, not server
domain truth. Quota eviction may remove `cache` entities, while explicitly
retained resources are considered separately. Losing any cache row is safe:
server snapshots, immutable article reads, and post revision awareness rebuild
authoritative state.

## SQLite schema baseline

Schema v17 is the server database baseline. The ordered migration registry is
currently empty; startup creates a new v17 database when no version is present
and rejects versions below the baseline. Future migrations are registered by
source version and each advances the version ledger in the same transaction as
its schema changes. There are no dual-write paths. The production v15 database
was upgraded once before adopting this baseline, with its source copy retained
outside the runtime database path.
