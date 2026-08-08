# User lifecycle

ClassApp distinguishes account deactivation from data purge.

## Deactivation

`UserService.remove(id, adminId, "deactivate")` performs one narrow use case:

1. `GroupService.removeUserFromAllGroups` removes every membership, including
   groups whose normal leave policy is `no_leave`.
2. `deleted_users` stores the stable user id, historical display name and
   deactivation time.
3. PINs and sessions are revoked and the active handle is released.

The row in `users` remains as a stable identity anchor for existing foreign
keys. Active-user reads always exclude ids present in `deleted_users`. Posts,
DM endpoints, articles, conversation state, preferences and learning progress
are not changed or notified. Historical joins use `deleted_users.username` and
return no active handle.

## Purge

`UserService.remove(id, adminId, "purge")` explicitly calls the owning services:

- `GroupService.purgeUser`
- `ConversationService.purgeUser`
- `PostService.purgeUser`
- `ArticleService.purgeUser`
- `WordsService.purgeUser`
- `ClientService.purgeUser`
- `UserConfigService.purgeUser`

Only after those calls complete does `UserService` physically delete the
identity. SQL stays in each service's Data module; orchestration and external
side effects stay in Service. A new service that owns per-user state must add a
`purgeUser` capability and be added to this orchestration list.
