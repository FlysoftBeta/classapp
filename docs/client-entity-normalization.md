# Client entity normalization

`domain_users` is the only client objective store for reusable user metadata.
`domain_posts` stores the Post entity and foreign identities only:

```text
user_id
reply_user_id
```

It does not store `username`, `handle`, `reply_username`, or `reply_handle`.
Post Actions and events carry `{ post(s), users }`; `client/interact` first
merges `users` into `domain_users`, then stores Posts. Repository reads join
both stores in one readonly IndexedDB transaction and return a presentation
`Post` to React.

This prevents a profile change from creating contradictory author metadata in
every historical Post. Missing metadata degrades to a neutral presentation and
can be repaired by a later payload. The server follows the same rule: Post SQL
does not join presentation names into every row; `PostService` emits a
deduplicated side bundle from referenced user ids.

The application schema version is bumped as a hard cache boundary. Objective
client data is reconstructible, so old denormalized rows are discarded rather
than supported through a compatibility reader.
