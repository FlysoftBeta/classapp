# Music and media runtime

## Product intent

The server owns a globally shared, deduplicated music catalog. A track becomes
usable as soon as its basic metadata exists: it can enter the anonymous play
queue or a user playlist while the audio downloads in the background. Audio and
cover are raw HTTP resources; business mutations are WebSocket Actions.

- Server tracks are deduplicated by `(source, provider_id)`.
- A downloaded track is a materialized view: the track row is the authority and
  the `media_assets` rows/files are reconstructible.
- Queue and playlist share the same list mechanics but have different
  ownership/lifecycle: playlists are durable per user, the queue is a single
  `user_id + TTL` row.
- `ref_count` counts `media_list_items` references and is maintained by SQLite
  triggers. Eviction only considers `ref_count = 0` rows.

## Ownership map

```text
lib/media/                         provider SDK; no server imports
  types.ts + track.ts + index.ts   stream-only contract + hidden track hints
  ytdlpProvider.ts                 yt-dlp search parsing, streamTrack/streamCover
  ytdlp-plugins/classapp-music-search/
                                   fast rich music-search extractor plugin
server/runtime/mediaRuntime.ts     process lifetime: jobs, leases, eviction, relay
server/runtime/mediaStreamSession.ts  one shared yt-dlp audio stream per track
server/runtime/potServer.ts        GPL POT provider child process supervisor
server/runtime/mediaThrottle.ts    provider process pacing and stream concurrency
server/services/mediaService.ts    track search/ensure/play/config
server/services/mediaPlaylistService.ts  queue + playlist mechanics
server/data/media.ts               SQL and row mapping
server/http/routes/mediaAudio.ts   grant, Range, seek-await, live relay
server/http/routes/mediaCover.ts   session-authenticated cover
server/storage/                    BlobStore, tree store, QuotaService
client/interact/media.ts           remote/local orchestration
client/data/media.ts               IndexedDB media projection
client/components/media/           search, queue, playlists, now-playing bar
client/hooks/useMediaPlayer.ts     Chrome 70 WebAudio pipeline
```

## Search

Upstream yt-dlp's YouTube Music search extractor only exposes id/title from
the song shelf and then downloads each video's webpage and player response to
recover artist, album, duration, and thumbnail. That costs seconds per track,
so a 20-track search spent roughly 40-80 s before the request could return.
`ytdlpProvider.search` therefore uses `--flat-playlist`, and the ClassApp
`classapp-music-search` extractor plugin reads those fields from the search
shelf renderer itself. A 20-track search stays on the `web_music` client and
returns in about 3 s.

The plugin subclasses yt-dlp's pinned `YoutubeMusicSearchURLIE`; when the
pinned yt-dlp release is bumped, review the plugin against the new extractor
API and the live renderer shape.

`ytdlpProvider` passes one `--extractor-args` option per extractor key.
Joining `youtube:` and `youtubepot-bgutilhttp:` keys with `;` parses the
built-in key but silently drops the plugin key, so yt-dlp ignores the
configured POT server and falls back to its default local port.

`lib/media` is a parsing/streaming boundary only: `MediaProvider` exposes
`search`, `streamTrack`, and `streamCover`. Search results carry the needed
metadata on the public `ProviderTrack`, while provider-specific locators such
as the cover URL ride in a hidden WeakMap slot. `streamCover` prefers that
hidden locator and otherwise performs one bounded `--dump-single-json` parse.
Rate limiting, staging, hashing, and quota belong to `MediaRuntime`, so the
provider itself has no download, storage, or throttle API.

## Data model (server schema v27)

`media_tracks` keeps identity and basic metadata. `media_assets` has one row per
`(track_id, kind)` with states `queued | downloading | ready | failed`; the
logical states are derived:

```text
metadata          = media_tracks row
playable          = audio asset ready
advanced_metadata = cover asset ready
dead              = no ready assets; legal when ref_count = 0
```

`media_lists` is playlist or queue only. Booklists are an articles-domain
table. Lists have no owner column; `access_bindings` stores principal grants
and `access_effective` materializes per-user flags. Queues are bound through
`user_queues` plus a user owner binding; the media facade does not offer
sharing a queue. `media_list_items`
positions are contiguous integers; inserts and deletes renumber in the same
Service transaction. `media_list_items` triggers increment/decrement
`media_tracks.ref_count`. Track snapshots are signed capabilities; see
[resource authorization](./resource-authorization.md).

## Streaming protocol

`GET /api/media/tracks/:id/audio?grant=...` looks up a short-lived
`media_stream_grants` row created by `media.play`. The row is not deleted on
the first GET: Chrome 70's `<audio>` issues several Range requests against the
same URL (a `bytes=0-1` probe, then `bytes=0-` / later windows), so the grant
remains valid until `expires_at`. Expired rows are deleted on lookup and by
maintenance GC.

- Ready asset: single-range `206` with `Accept-Ranges`. The grant URL can be
  reused for every Range GET until expiry.
- Prefix or no Range (`bytes=0-`, `bytes=0-N`, or omitted):
  `MediaRuntime.streamTrack` opens the provider's `streamTrack`
  (`yt-dlp --output -`) and relays chunked `audio/webm` as `200`. A prefix
  probe is not a seek; answering `200` lets the element play while
  materialization continues. Seek is unavailable until the file is ready.
- Mid-file seek (`bytes=N-` with N>0, or `bytes=-N`): the request awaits
  materialization readiness (bounded waiters), then answers `206`; timeout is
  `503 Retry-After`.
- Cover: `/api/media/tracks/:id/cover?token=...` uses the normal session token
  and waits for the cover job on first access. The cover job consumes
  `streamCover` into a staged BlobStore slot.

A background materialization starts when a track is queued or played, so
listening normally populates the shared cache. Every attempt publishes under a
fresh allocated `blob_id`, so eviction of a deleted asset row can never reclaim
a newer attempt's file. Audio materialization and all
live relays for the same track share one yt-dlp invocation through
`AudioStreamSession`: the session owns the provider stream, fans chunks out to
each relay subscriber with a bounded queue, and feeds the materialization
subscription that writes the staged BlobStore slot. Relay consumers that fall
more than 64 MiB behind are dropped so a stalled client cannot block the shared
stream; materialization applies backpressure instead. `ConcurrencyLimiter`
bounds distinct provider-backed audio streams to a small fixed number, so many
different tracks cannot spawn unbounded yt-dlp processes at once.

## Ref counting and quota eviction

- `media_tracks.last_used_at` is a last-touch timestamp: asset publish and
  playback grant both update it. Naming avoids pretending download activity was
  a play.
- Ready bytes are accounted in the shared `storage_quota_items` ledger under
  the `media` pool. One cache item per track carries `weight`, `heat`, and
  `touched_at_ms`. A touch decays existing heat by half-life, then adds
  intensity: `heat = heat_now + intensity`.
- Every maintenance minute the QuotaService emits cache candidates ranked by
  `weight / (heat_now + ε)` while cache weight exceeds `media_storage_limit_bytes`
  (default 4 GiB), targeting 80% of the limit. `max_weight = 0` disables size
  eviction. Durable items never enter the candidate set.
- `ref_count = 0` remains a per-track compare-and-delete requirement inside the
  owner evictor, and a stream lease must be acquired before reading a ready
  asset row. Eviction deletes the DB rows only while no lease exists, commits,
  then `drop`s the BlobStore files. A later stream request sees no
  ready row and uses the relay, so no request can open a file an eviction is
  reclaiming.
- Queue membership protects the track through `ref_count`. Direct grant
  playback without queue membership is protected by the lease, because clients
  are not trusted to maintain the queue.

## Client model

- `client/data/media.ts` stores objective tracks, actor-owned list projections
  and claims in the existing `domain_save` claim table (`kind = "media"`).
- Server `ref_count` is deliberately not mirrored. Local retention uses claims;
  default play claim is seven days (same touch policy as the server).
- Zustand `useMediaStore` is presentation state only: queue/playlist/search
  projections and the player position. Durable rows stay in IndexedDB.
- Media has distinct `AppRoute` pages: `media` is the search-only home and
  `media-playlist` opens one playlist page. Search results render in an
  anchored Popover over the home page; playlist management lives in the
  sidebar and on the playlist page.
- Playlist summaries carry only `cover_track_id` (the first item). Clients
  build the session-authenticated `/api/media/tracks/:id/cover` URL from it;
  cover display never references external thumbnail hosts because the
  deployment is an intranet.
- Sidebar playlists are sorted by last played. Last-played timestamps are a
  durable local projection in `media_lists` rows, merged across snapshot
  writes; the server ordering remains the fallback.
- `NowPlayingBar` owns progress, transport, volume, and the queue drawer entry
  point. While a media route is open it floats over the content column with a
  blurred background; elsewhere it collapses into a bottom-right capsule
  (next, play/pause, stop) above the chat ComposeBar.
- Volume pipeline: `<audio>` → `MediaElementAudioSourceNode` → `GainNode` →
  destination. Effective gain is `min(user volume, media_max_volume)`; the cap
  is server policy for managed devices, not cryptographic enforcement.

## Packaging

`lib/media/artifacts-manifest.json` is the pinned build input:

- Linux: `yt-dlp_linux` (standalone, ~39 MB).
- Windows: `yt-dlp_win.zip` → `yt-dlp.exe` plus `_internal/`.
- POT plugin: upstream release zip extracted to `server/media/pot-plugin`.
- ClassApp search plugin: `lib/media/ytdlp-plugins/classapp-music-search` is
  copied beside the POT plugin into the same `server/media/pot-plugin` plugin
  root. Development loads it from `lib/media/ytdlp-plugins`.
- POT server: GPL-3.0 separate process, prepared into
  `.cache/media/pot-server/<tag>/<platform>` by `npm run media:update`.
  Normal builds never run npm/tsc/git; a missing POT server cache fails with
  instructions.

`npm run media:update` refreshes yt-dlp/plugin URLs and SHA-256 values in the
manifest, caches both yt-dlp platforms and the extracted plugin under
`.cache/media`, and rebuilds the POT server cache for the requested platform.
Use `--platform linux|windows` to prepare the other platform. Development
resolves the same `.cache/media` tree, so run the update once after cloning
before using media features in `npm run dev`.

`--prepare-cache` skips GitHub release refresh and does not rewrite the
committed manifest. Hosted Windows assembly uses that flag so CI packages the
pinned yt-dlp/POT versions rather than whatever is latest on the day of the run.

## Known limitations

- Offline playback works for tracks whose verified extent file exists; the
  player stores a ready server asset into `media:<track_id>:audio` after
  checking byte size and SHA-256. Tracks that were only streamed live must be
  materialized by the server before their first offline use.
- Relay subscribers have a bounded 64 MiB queue; a client that stops reading
  for long enough is dropped from the shared stream and must resume by
  re-requesting playback.
- Seek before materialization waits; very slow downloads can exceed the
  120-second seek wait and surface `503`.
- Playlist retention (1-365 days) controls the local claim for tracks played
  from that playlist; queue-only plays use the default seven-day claim.
- POT provider upstream binds all interfaces; deployment firewalls must keep
  the provider port off the LAN until upstream changes to loopback.
