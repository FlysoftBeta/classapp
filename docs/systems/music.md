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
  ytdlpProvider.ts                 normalized yt-dlp search/download/live relay
  potServer.ts                     GPL POT provider child process supervisor
  ytdlp-plugins/classapp-music-search/
                                   fast rich music-search extractor plugin
server/runtime/mediaRuntime.ts     process lifetime: jobs, leases, eviction
server/services/mediaService.ts    track search/ensure/play/config
server/services/mediaPlaylistService.ts  queue + playlist mechanics
server/data/media.ts               SQL and row mapping
server/http/routes/mediaAudio.ts   grant, Range, seek-await, live relay
server/http/routes/mediaCover.ts   session-authenticated cover
server/infra/mediaStore.ts         injected-root object store factory
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

## Data model (server schema v23)

`media_tracks` keeps identity and basic metadata. `media_assets` has one row per
`(track_id, kind)` with states `queued | downloading | ready | failed`; the
logical states are derived:

```text
metadata          = media_tracks row
playable          = audio asset ready
advanced_metadata = cover asset ready
dead              = no ready assets; legal when ref_count = 0
```

`media_lists` is one table with `kind = 'playlist' | 'queue'`. A partial unique
index allows one queue per user. `media_list_items` positions are contiguous
integers; inserts and deletes renumber in the same Service transaction.
`media_list_items` triggers increment/decrement `media_tracks.ref_count`.

## Streaming protocol

`GET /api/media/tracks/:id/audio?grant=...` consumes a short-lived
`media_stream_grants` row created by `media.play`.

- Ready asset: single-range `206` with `Accept-Ranges`.
- Open-ended start (`Range: bytes=0-` or no Range): yt-dlp `--output -` relay
  as chunked `audio/webm`; seek is unavailable until materialization finishes.
- Real seek (`bytes=N-`, N>0, or a closed range): the request awaits
  materialization readiness (bounded waiters), then answers `206`; timeout is
  `503 Retry-After`.
- Cover: `/api/media/tracks/:id/cover?token=...` uses the normal session token
  and waits for the cover job on first access.

A background `MaterializeJob` starts when a track is queued or played, so
listening normally populates the shared cache. The current relay and the
background job are separate yt-dlp invocations; merging them into one tee is a
known follow-up, not a correctness gap.

## Ref counting and eviction

- `media_tracks.last_used_at` is a last-touch timestamp: asset publish and
  playback grant both update it. Naming avoids pretending download activity was
  a play.
- Every minute maintenance runs age eviction for
  `ref_count = 0 AND last_used_at < now - media_eviction_days` (default 7),
  then size eviction while `SUM(ready bytes) > media_storage_limit_bytes`
  (default 4 GiB), targeting 80% of the limit. Size eviction removes covers
  first (LRU), then whole tracks.
- A stream lease must be acquired before reading a ready asset row. Eviction
  deletes the DB row only while no lease exists, commits, then renames files
  into trash. A later stream request sees no ready row and uses the relay, so
  no request can open a file an eviction is reclaiming.
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

## Known limitations

- Offline playback works for tracks whose verified extent file exists; the
  player stores a ready server asset into `media:<track_id>:audio` after
  checking byte size and SHA-256. Tracks that were only streamed live must be
  materialized by the server before their first offline use.
- Live relay and background materialization duplicate external bandwidth for
  the first listener of a track.
- Seek before materialization waits; very slow downloads can exceed the
  120-second seek wait and surface `503`.
- Playlist retention (1-365 days) controls the local claim for tracks played
  from that playlist; queue-only plays use the default seven-day claim.
- POT provider upstream binds all interfaces; deployment firewalls must keep
  the provider port off the LAN until upstream changes to loopback.
