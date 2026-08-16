# Learning, imports, announcements, and teaching support

Smaller features still follow the same ownership rules. Their size does not
justify bypassing Facades, lifecycle, Data, purge, Incidents, or compatibility.

## Vocabulary learning

The word catalog is objective server data. `user_word_progress` is per-user
practice state: learned/wrong counters, mastered status, and timestamps. Quiz
selection combines unlearned and weighted wrong-word candidates; distractors
come from other stable word identities.

Rules:

- import/seed is an explicit bounded startup/administrative mechanism, not a
  hidden side effect of ordinary reads;
- randomness is injectable for deterministic tests and avoids biased
  `sort(() => Math.random() - .5)` in a future cleanup;
- timezone offset affects day statistics only through a documented day-boundary
  rule;
- self-discipline scheduling is presentation/notification policy, while practice
  recording remains server-authoritative;
- user purge removes progress but not the shared word catalog;
- word schema creation belongs in central DB schema/migrations, even though the
  current Data module still creates tables.

## Versioned user configuration and notifications

Do-not-disturb, self-discipline, theme, and similar settings must be classified
as independently versioned user decisions when offline editing is supported.
Raw `UserConfigService` is a storage mechanism; `VersionedUserConfigService` and
actor Facades express merge/ownership. Do not add another unversioned string key
and implement local fallback in a component.

Notification presentation consumes the canonical decision. It does not redefine
whether an event is persisted or recovered.

## Announcements

An announcement is a revisioned system publication with per-user acknowledgement
of a named revision. Changing content increments/replaces the authoritative
revision and publishes a system hint; acknowledgement of an old revision does
not acknowledge a new one.

Publication requires the advanced community responsibility and safe audit.
System event is post-commit and reconnect/probe can recover current content.
Announcement Group membership and the global announcement banner are related
product experiences but remain distinct domain mechanisms.

## Network Article import

The Tomato client/pool, queue, progress, and running tasks outlive requests and
belong to `ArticleImportRuntime`. The request-bound Service exposes search,
start, and list for one actor without retaining Scope in tasks.

An import captures immutable user/group/book identity, validates authority
before queueing, bounds concurrency/quota/download, and creates an Article only
after complete content validation. Process restart currently loses the in-memory
task registry; if imports must become durable, add a persisted state machine and
startup reconciliation rather than serializing request objects.

External source errors are contained per task and produce Incident context with
IDs, not downloaded bodies or credentials. Provider scraping/encoding logic
stays in `lib/tomato`, not in UI or Article Data.

## Teaching documents and office monitor

On Windows, a process-bound monitor polls supported Microsoft Office/WPS COM
applications through a controlled PowerShell child, identifies newly opened
saved documents, and serializes captures. Captured copies are operational
artifacts retained for a bounded period (currently seven days), listed/downloaded
only by the responsible administration role.

Security and lifecycle rules:

- the PowerShell program is fixed code; browser input never becomes command text;
- validate parsed child output and bound buffers/line handling;
- monitor child restart has cooldown and stop ownership;
- capture streams into a shared ObjectStore object (`teach-documents` namespace)
  before inserting metadata, with compensation if DB insertion fails;
- the dynamically configured `teach-documents` quota group ages items out after
  seven days through the shared QuotaService evictor; downloads touch the item;
- cleanup records per-file failures and deletes metadata only for objects
  actually removed;
- download resolves a stored object key through the ObjectStore, not an
  arbitrary path;
- audit downloads/destructive cleanup according to operations policy;
- Incident context should avoid leaking full sensitive host paths when not
  needed.

`TeachDocumentsRuntime` owns this process boundary: `Runtime` composes it,
startup configures the quota group and backfills its ledger before starting the
monitor, and shutdown kills the child and clears its restart timer. The
request-bound `TeachDocumentsService` only lists, streams downloads, touches
quota accounting, and orchestrates destructive cleanup through the runtime
evictor. It never starts the monitor or configures process quota policy.

## Stickers and other catalogs

Static sticker packs are build-time/public assets with validated manifests.
Recent-sticker ordering is actor/user decision state. Sending a sticker is still
a Post command through the Post Facade; the catalog must never become a bypass
around posting authority or content validation.
