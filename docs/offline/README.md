# Offline architecture

Offline support is not a collection of fallback `catch` blocks. It is a second
execution mode with explicit ownership, partial-knowledge proofs, reconciliation
algebras, storage publication, quota policy, secure boot, and actor isolation.

## The four layers

```text
offline entry
  Service Worker caches the selected stable Shell

offline executable
  Shell loads the selected monolithic application bundle from IndexedDB

offline domain projection
  normalized objective entities + actor projections + user decisions

offline materialization
  text segments, document bundle resources, Post windows, retention and quota
```

All four must work together. Caching API responses without a bootable
application is not offline support. A bootable UI that cannot distinguish
partial data from complete data is not correct offline support.

## Core invariants

- React never chooses online versus offline and never writes raw IndexedDB.
- `client/data` owns mechanisms; `client/interact` owns policy.
- Objective entities are stored once per device; actor visibility and decisions
  are keyed by stable user ID.
- Pending proposals are never evicted or cleared by an old response.
- A coverage row is a proof, not a row count.
- Events are queued during recovery and replayed only after authoritative repair.
- Actor context is captured at operation start and never reread from mutable
  global state after an asynchronous boundary.
- Cache loss is recoverable; loss of an unsynced user decision is not.
- Published binary generations are complete; readers never observe staging.
- Chrome 70 behavior is the compatibility authority.

## Documents

- [Local data model and ownership](./local-model.md)
- [Consistency and recovery protocols](./consistency-and-recovery.md)
- [RemoteManager connection reliability](./remote-connectivity.md)
- [Binary storage, retention, and quota](./storage-and-quota.md)
- [Shell, HTTPS, and offline boot](./shell-and-https.md)

## What is allowed offline

Offline-safe operations are those whose truth can be represented as a local
decision with a declared merge algebra: theme, reader settings, draft, mute,
pin, bookmark, resume position, furthest-read watermark, retention claim.

Operations that establish shared server facts remain unavailable: joining a
group, creating a DM, publishing a Post/article, changing membership, or
performing administration. Do not create optimistic server entities and later
pretend they were accepted. A compose draft may exist locally; an established
Post cannot.
