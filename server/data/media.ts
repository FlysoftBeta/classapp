import crypto from "node:crypto";
import type { Database } from "better-sqlite3";
import type {
  MediaAsset,
  MediaConfig,
  MediaListSnapshot,
  MediaPlaylistSummary,
  MediaTrack,
} from "@/shared/media/types";
import {
  quotaPoolPolicy,
  upsertQuotaPool,
  type QuotaPoolPolicy,
} from "@/server/data/quota";

export interface TrackInput {
  source: string;
  providerId: string;
  canonicalUrl: string;
  title: string;
  artists: string[];
  album: string | null;
  durationMs: number;
  thumbnailUrl: string | null;
}

export interface MediaAssetRow {
  track_id: string;
  kind: "audio" | "cover";
  state: "queued" | "downloading" | "ready" | "failed";
  blob_id: string | null;
  mime: string | null;
  bytes: number;
  sha256: string | null;
  failed_code: string | null;
  downloaded_at: string | null;
  updated_at: string;
}

interface MediaListRow {
  id: string;
  kind: "playlist" | "queue";
  owner_user_id: string;
  title: string;
  revision: number;
  retention_days: number;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

interface MediaListItemRow {
  track_id: string;
  position: number;
  added_at: string;
}

const TRACK_SELECT = `
  SELECT t.id, t.source, t.provider_id, t.canonical_url, t.title,
         t.artists_json, t.album, t.duration_ms, t.thumbnail_url,
         t.metadata_revision, t.ref_count, t.last_used_at, t.created_at
    FROM media_tracks t`;

function parseArtists(raw: unknown): string[] {
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function emptyAsset(): MediaAsset {
  return {
    state: "absent",
    mime: null,
    bytes: 0,
    sha256: null,
    downloaded_at: null,
  };
}

export function rowToMediaTrack(
  row: Record<string, unknown>,
  assets: MediaAssetRow[] = [],
): MediaTrack {
  const audio = assets.find((asset) => asset.kind === "audio") ?? null;
  const cover = assets.find((asset) => asset.kind === "cover") ?? null;
  return {
    id: String(row.id),
    source: String(row.source),
    provider_id: String(row.provider_id),
    canonical_url: String(row.canonical_url),
    title: String(row.title),
    artists: parseArtists(row.artists_json),
    album: typeof row.album === "string" ? row.album : null,
    duration_ms: Number(row.duration_ms),
    thumbnail_url:
      typeof row.thumbnail_url === "string" ? row.thumbnail_url : null,
    metadata_revision: Number(row.metadata_revision),
    last_used_at:
      typeof row.last_used_at === "string" ? row.last_used_at : null,
    created_at: String(row.created_at),
    materialization: {
      audio: audio
        ? {
            state: audio.state,
            mime: audio.mime,
            bytes: audio.bytes,
            sha256: audio.sha256,
            downloaded_at: audio.downloaded_at,
          }
        : emptyAsset(),
      cover: cover
        ? {
            state: cover.state,
            mime: cover.mime,
            bytes: cover.bytes,
            sha256: cover.sha256,
            downloaded_at: cover.downloaded_at,
          }
        : emptyAsset(),
    },
  };
}

function trackRow(db: Database, id: string): Record<string, unknown> | null {
  const row = db.prepare(`${TRACK_SELECT} WHERE t.id = ?`).get(id) as
    Record<string, unknown> | undefined;
  return row ?? null;
}

export function ensureTrack(db: Database, input: TrackInput): MediaTrack {
  db.prepare(
    `INSERT INTO media_tracks
       (id, source, provider_id, canonical_url, title, artists_json, album,
        duration_ms, thumbnail_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source, provider_id) DO UPDATE SET
       canonical_url = excluded.canonical_url,
       title = excluded.title,
       artists_json = excluded.artists_json,
       album = excluded.album,
       duration_ms = excluded.duration_ms,
       thumbnail_url = excluded.thumbnail_url,
       metadata_revision = media_tracks.metadata_revision + 1,
       updated_at = datetime('now')`,
  ).run(
    crypto.randomUUID(),
    input.source,
    input.providerId,
    input.canonicalUrl,
    input.title,
    JSON.stringify(input.artists),
    input.album,
    input.durationMs,
    input.thumbnailUrl,
  );
  const row = db
    .prepare(`${TRACK_SELECT} WHERE t.source = ? AND t.provider_id = ?`)
    .get(input.source, input.providerId) as Record<string, unknown>;
  const assets = listAssets(db, String(row.id));
  return rowToMediaTrack(row, assets);
}

export function getTrack(db: Database, id: string): MediaTrack | null {
  const row = trackRow(db, id);
  if (!row) return null;
  return rowToMediaTrack(row, listAssets(db, id));
}

export function listAssets(db: Database, trackId: string): MediaAssetRow[] {
  return db
    .prepare(
      `SELECT track_id, kind, state, blob_id, mime, bytes, sha256,
              failed_code, downloaded_at, updated_at
         FROM media_assets WHERE track_id = ?`,
    )
    .all(trackId) as MediaAssetRow[];
}

export function listTracks(db: Database, ids: string[]): MediaTrack[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db
    .prepare(`${TRACK_SELECT} WHERE t.id IN (${placeholders})`)
    .all(...ids) as Array<Record<string, unknown>>;
  const assets = db
    .prepare(
      `SELECT track_id, kind, state, blob_id, mime, bytes, sha256,
              failed_code, downloaded_at, updated_at
         FROM media_assets WHERE track_id IN (${placeholders})`,
    )
    .all(...ids) as MediaAssetRow[];
  const byTrack = new Map<string, MediaAssetRow[]>();
  for (const asset of assets) {
    const list = byTrack.get(asset.track_id) ?? [];
    list.push(asset);
    byTrack.set(asset.track_id, list);
  }
  return rows.map((row) => rowToMediaTrack(row, byTrack.get(String(row.id))));
}

export function findReadyAsset(
  db: Database,
  trackId: string,
  kind: "audio" | "cover",
): MediaAssetRow | null {
  const row = db
    .prepare(
      `SELECT track_id, kind, state, blob_id, mime, bytes, sha256,
              failed_code, downloaded_at, updated_at
         FROM media_assets WHERE track_id = ? AND kind = ? AND state = 'ready'`,
    )
    .get(trackId, kind) as MediaAssetRow | undefined;
  return row ?? null;
}

export function markAssetDownloading(
  db: Database,
  trackId: string,
  kind: "audio" | "cover",
  blobId: string,
): void {
  db.prepare(
    `INSERT INTO media_assets (track_id, kind, state, blob_id, updated_at)
     VALUES (?, ?, 'downloading', ?, datetime('now'))
     ON CONFLICT(track_id, kind) DO UPDATE SET
       state = CASE WHEN media_assets.state = 'ready'
         THEN media_assets.state ELSE 'downloading' END,
       blob_id = CASE WHEN media_assets.state = 'ready'
         THEN media_assets.blob_id ELSE excluded.blob_id END,
       failed_code = NULL,
       updated_at = datetime('now')`,
  ).run(trackId, kind, blobId);
}

export function publishAsset(
  db: Database,
  trackId: string,
  kind: "audio" | "cover",
  input: { blobId: string; mime: string; bytes: number; sha256: string },
): void {
  db.prepare(
    `UPDATE media_assets SET
       state = 'ready',
       blob_id = ?,
       mime = ?,
       bytes = ?,
       sha256 = ?,
       failed_code = NULL,
       downloaded_at = datetime('now'),
       updated_at = datetime('now')
     WHERE track_id = ? AND kind = ?`,
  ).run(input.blobId, input.mime, input.bytes, input.sha256, trackId, kind);
  touchTrack(db, trackId);
}

export function markAssetFailed(
  db: Database,
  trackId: string,
  kind: "audio" | "cover",
  code: string,
): void {
  db.prepare(
    `INSERT INTO media_assets (track_id, kind, state, failed_code, updated_at)
     VALUES (?, ?, 'failed', ?, datetime('now'))
     ON CONFLICT(track_id, kind) DO UPDATE SET
       state = CASE WHEN media_assets.state = 'ready'
         THEN media_assets.state ELSE 'failed' END,
       failed_code = ?,
       updated_at = datetime('now')`,
  ).run(trackId, kind, code, code);
}

export function touchTrack(db: Database, trackId: string): void {
  db.prepare(
    "UPDATE media_tracks SET last_used_at = datetime('now') WHERE id = ?",
  ).run(trackId);
}

// ── Lists ────────────────────────────────────────────────────────────────────

const LIST_SELECT = `
  SELECT l.id, l.kind, l.owner_user_id, l.title, l.revision,
         l.retention_days, l.expires_at, l.created_at, l.updated_at,
         (SELECT t.id
            FROM media_list_items i
            JOIN media_tracks t ON t.id = i.track_id
           WHERE i.list_id = l.id
           ORDER BY i.position
           LIMIT 1) AS cover_track_id
    FROM media_lists l`;

const QUEUE_TTL_HOURS = 24;
const QUEUE_TITLE = "播放队列";

export function getOrCreateQueue(db: Database, userId: string): MediaListRow {
  db.prepare(
    `INSERT INTO media_lists (id, kind, owner_user_id, title, expires_at)
     VALUES (?, 'queue', ?, ?, datetime('now', '+${QUEUE_TTL_HOURS} hours'))
     ON CONFLICT(owner_user_id) WHERE kind = 'queue'
     DO NOTHING`,
  ).run(crypto.randomUUID(), userId, QUEUE_TITLE);
  return db
    .prepare(`${LIST_SELECT} WHERE kind = 'queue' AND owner_user_id = ?`)
    .get(userId) as MediaListRow;
}

function touchList(db: Database, list: MediaListRow): void {
  db.prepare(
    `UPDATE media_lists SET
       revision = revision + 1,
       updated_at = datetime('now'),
       expires_at = CASE WHEN kind = 'queue'
         THEN datetime('now', '+${QUEUE_TTL_HOURS} hours') ELSE expires_at END
     WHERE id = ?`,
  ).run(list.id);
}

function summaryFromRow(
  row: MediaListRow | Record<string, unknown>,
  trackCount: number,
): MediaPlaylistSummary {
  const value = row as Record<string, unknown>;
  return {
    id: String(value.id),
    title: String(value.title),
    revision: Number(value.revision),
    retention_days: Number(value.retention_days),
    created_at: String(value.created_at),
    updated_at: String(value.updated_at),
    track_count: trackCount,
    cover_track_id:
      typeof value.cover_track_id === "string" ? value.cover_track_id : null,
  };
}

function itemsForList(db: Database, listId: string): MediaListItemRow[] {
  return db
    .prepare(
      `SELECT track_id, position, added_at
         FROM media_list_items WHERE list_id = ? ORDER BY position`,
    )
    .all(listId) as MediaListItemRow[];
}

function listSummary(
  db: Database,
  row: Record<string, unknown>,
): MediaPlaylistSummary {
  const count = db
    .prepare("SELECT COUNT(*) AS n FROM media_list_items WHERE list_id = ?")
    .get(String(row.id)) as { n: number };
  return summaryFromRow(row, count.n);
}

export function listSnapshots(
  db: Database,
  rows: Array<Record<string, unknown>>,
): MediaListSnapshot[] {
  const trackIds = new Set<string>();
  for (const row of rows) {
    for (const item of itemsForList(db, String(row.id))) {
      trackIds.add(item.track_id);
    }
  }
  const tracks = listTracks(db, [...trackIds]);
  return rows.map((row) => {
    const items = itemsForList(db, String(row.id));
    return {
      list: listSummary(db, row),
      items,
      tracks: tracks.filter((track) =>
        items.some((item) => item.track_id === track.id),
      ),
    };
  });
}

export function queueSnapshot(db: Database, userId: string): MediaListSnapshot {
  const queue = getOrCreateQueue(db, userId);
  const items = itemsForList(db, queue.id);
  const tracks = listTracks(
    db,
    items.map((item) => item.track_id),
  );
  return {
    list: summaryFromRow(queue, items.length),
    items,
    tracks,
  };
}

export function addQueueItem(
  db: Database,
  userId: string,
  trackId: string,
): MediaListSnapshot {
  const queue = getOrCreateQueue(db, userId);
  const row = db
    .prepare(
      "SELECT COALESCE(MAX(position), -1) + 1 AS position FROM media_list_items WHERE list_id = ?",
    )
    .get(queue.id) as { position: number };
  db.prepare(
    "INSERT INTO media_list_items (list_id, position, track_id) VALUES (?, ?, ?)",
  ).run(queue.id, row.position, trackId);
  touchList(db, queue);
  return queueSnapshot(db, userId);
}

export function removeQueueItem(
  db: Database,
  userId: string,
  trackId: string,
): MediaListSnapshot {
  const queue = getOrCreateQueue(db, userId);
  const row = db
    .prepare(
      "SELECT position FROM media_list_items WHERE list_id = ? AND track_id = ? ORDER BY position LIMIT 1",
    )
    .get(queue.id, trackId) as { position: number } | undefined;
  if (row) {
    db.prepare(
      "DELETE FROM media_list_items WHERE list_id = ? AND position = ?",
    ).run(queue.id, row.position);
    renumberItems(db, queue.id);
    touchList(db, queue);
  }
  return queueSnapshot(db, userId);
}

export function clearQueue(db: Database, userId: string): MediaListSnapshot {
  const queue = getOrCreateQueue(db, userId);
  db.prepare("DELETE FROM media_list_items WHERE list_id = ?").run(queue.id);
  touchList(db, queue);
  return queueSnapshot(db, userId);
}

export function listPlaylists(
  db: Database,
  userId: string,
): MediaPlaylistSummary[] {
  const rows = db
    .prepare(
      `${LIST_SELECT} WHERE kind = 'playlist' AND owner_user_id = ?
       ORDER BY updated_at DESC`,
    )
    .all(userId) as Array<Record<string, unknown>>;
  return rows.map((row) => listSummary(db, row));
}

export function createPlaylist(
  db: Database,
  userId: string,
  title: string,
): MediaListSnapshot {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO media_lists (id, kind, owner_user_id, title)
     VALUES (?, 'playlist', ?, ?)`,
  ).run(id, userId, title);
  return playlistSnapshot(db, userId, id);
}

export function playlistSnapshot(
  db: Database,
  userId: string,
  listId: string,
): MediaListSnapshot {
  const row = db
    .prepare(
      `${LIST_SELECT} WHERE kind = 'playlist' AND owner_user_id = ? AND id = ?`,
    )
    .get(userId, listId) as Record<string, unknown> | undefined;
  if (!row) throw new Error("playlist not found");
  const items = itemsForList(db, listId);
  return {
    list: listSummary(db, row),
    items,
    tracks: listTracks(
      db,
      items.map((item) => item.track_id),
    ),
  };
}

export function addPlaylistItem(
  db: Database,
  userId: string,
  listId: string,
  trackId: string,
): MediaListSnapshot {
  const list = db
    .prepare(
      `${LIST_SELECT} WHERE kind = 'playlist' AND owner_user_id = ? AND id = ?`,
    )
    .get(userId, listId) as MediaListRow | undefined;
  if (!list) throw new Error("playlist not found");
  const existing = db
    .prepare(
      "SELECT 1 FROM media_list_items WHERE list_id = ? AND track_id = ?",
    )
    .get(listId, trackId);
  if (!existing) {
    const position = db
      .prepare(
        "SELECT COALESCE(MAX(position), -1) + 1 AS position FROM media_list_items WHERE list_id = ?",
      )
      .get(listId) as { position: number };
    db.prepare(
      "INSERT INTO media_list_items (list_id, position, track_id) VALUES (?, ?, ?)",
    ).run(listId, position.position, trackId);
    touchList(db, list);
  }
  return playlistSnapshot(db, userId, listId);
}

export function removePlaylistItem(
  db: Database,
  userId: string,
  listId: string,
  trackId: string,
): MediaListSnapshot {
  const list = db
    .prepare(
      `${LIST_SELECT} WHERE kind = 'playlist' AND owner_user_id = ? AND id = ?`,
    )
    .get(userId, listId) as MediaListRow | undefined;
  if (!list) throw new Error("playlist not found");
  db.prepare(
    "DELETE FROM media_list_items WHERE list_id = ? AND track_id = ?",
  ).run(listId, trackId);
  renumberItems(db, listId);
  touchList(db, list);
  return playlistSnapshot(db, userId, listId);
}

export function updatePlaylistRetention(
  db: Database,
  userId: string,
  listId: string,
  days: number,
): MediaListSnapshot {
  const list = db
    .prepare(
      `${LIST_SELECT} WHERE kind = 'playlist' AND owner_user_id = ? AND id = ?`,
    )
    .get(userId, listId) as MediaListRow | undefined;
  if (!list) throw new Error("playlist not found");
  db.prepare(
    `UPDATE media_lists SET retention_days = ?, revision = revision + 1,
       updated_at = datetime('now') WHERE id = ?`,
  ).run(days, listId);
  return playlistSnapshot(db, userId, listId);
}

export function deletePlaylist(
  db: Database,
  userId: string,
  listId: string,
): void {
  const list = db
    .prepare(
      `${LIST_SELECT} WHERE kind = 'playlist' AND owner_user_id = ? AND id = ?`,
    )
    .get(userId, listId) as MediaListRow | undefined;
  if (!list) throw new Error("playlist not found");
  // Explicit item deletion guarantees the ref_count triggers run.
  db.prepare("DELETE FROM media_list_items WHERE list_id = ?").run(listId);
  db.prepare("DELETE FROM media_lists WHERE id = ?").run(listId);
}

function renumberItems(db: Database, listId: string): void {
  const rows = db
    .prepare(
      "SELECT track_id, position FROM media_list_items WHERE list_id = ? ORDER BY position",
    )
    .all(listId) as Array<{ track_id: string; position: number }>;
  const update = db.prepare(
    "UPDATE media_list_items SET position = ? WHERE list_id = ? AND track_id = ? AND position = ?",
  );
  rows.forEach((row, index) => {
    if (row.position !== index) {
      update.run(index, listId, row.track_id, row.position);
    }
  });
}

// ── Asset deletion ───────────────────────────────────────────────────────────

function listReadyBlobIds(db: Database, trackId: string): string[] {
  const rows = db
    .prepare(
      "SELECT blob_id FROM media_assets WHERE track_id = ? AND state = 'ready' AND blob_id IS NOT NULL",
    )
    .all(trackId) as Array<{ blob_id: string }>;
  return rows.map((row) => row.blob_id);
}

export function deleteAssetsForTrack(db: Database, trackId: string): string[] {
  const ids = listReadyBlobIds(db, trackId);
  db.prepare("DELETE FROM media_assets WHERE track_id = ?").run(trackId);
  return ids;
}

/** Compare-and-delete: only reclaim a track that is still unreferenced. */
export function deleteAssetsIfUnreferenced(
  db: Database,
  trackId: string,
): string[] | null {
  const row = db
    .prepare("SELECT ref_count FROM media_tracks WHERE id = ?")
    .get(trackId) as { ref_count: number } | undefined;
  if (!row || row.ref_count !== 0) return null;
  return deleteAssetsForTrack(db, trackId);
}

export function readyAssetBytesForTrack(db: Database, trackId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(bytes), 0) AS total
         FROM media_assets WHERE track_id = ? AND state = 'ready'`,
    )
    .get(trackId) as { total: number };
  return row.total;
}

/**
 * Seed/refresh media cache weights. Heat and touched_at are left untouched so
 * a maintenance backfill cannot rewind the clock.
 */
export function reconcileReadyAssetQuotaItems(db: Database, now = Date.now()): void {
  db.prepare(
    `INSERT INTO storage_quota_items
       (pool, item_id, class, weight, heat, touched_at_ms, pin_until_ms, created_at_ms)
     SELECT 'media', track_id, 'cache', SUM(bytes), 1, ?, 0, ?
       FROM media_assets
      WHERE state = 'ready'
      GROUP BY track_id
     ON CONFLICT(pool, item_id) DO UPDATE SET
       weight = excluded.weight`,
  ).run(now, now);
}

// ── Config and grants ────────────────────────────────────────────────────────

export const MEDIA_QUOTA_POOL = "media";
const MEDIA_TARGET_RATIO = 0.8;
const MEDIA_DEFAULT_LIMIT_BYTES = 4 * 1024 * 1024 * 1024;
const MEDIA_DEFAULT_HALF_LIFE_MS = 7 * 24 * 60 * 60_000;

export function mediaQuotaPolicy(db: Database): QuotaPoolPolicy {
  return (
    quotaPoolPolicy(db, MEDIA_QUOTA_POOL) ?? {
      name: MEDIA_QUOTA_POOL,
      maxWeight: MEDIA_DEFAULT_LIMIT_BYTES,
      targetRatio: MEDIA_TARGET_RATIO,
      halfLifeMs: MEDIA_DEFAULT_HALF_LIFE_MS,
    }
  );
}

export function mediaConfig(db: Database): MediaConfig {
  const volume = db
    .prepare("SELECT value FROM config WHERE key = 'media_max_volume'")
    .get() as { value: string } | undefined;
  const quota = mediaQuotaPolicy(db);
  return {
    enabled: true,
    max_volume: Number(volume?.value ?? "1"),
    eviction_days: Math.max(1, Math.round(quota.halfLifeMs / (24 * 60 * 60_000))),
    storage_limit_bytes: quota.maxWeight,
  };
}

export function updateMediaConfig(
  db: Database,
  input: {
    max_volume?: number;
    eviction_days?: number;
    storage_limit_bytes?: number;
  },
): MediaConfig {
  if (input.max_volume !== undefined) {
    db.prepare(
      `INSERT INTO config (key, value) VALUES ('media_max_volume', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(String(input.max_volume));
  }
  const current = mediaQuotaPolicy(db);
  upsertQuotaPool(db, {
    name: current.name,
    maxWeight: input.storage_limit_bytes ?? current.maxWeight,
    targetRatio: current.targetRatio,
    halfLifeMs:
      input.eviction_days !== undefined
        ? input.eviction_days * 24 * 60 * 60_000
        : current.halfLifeMs,
  });
  return mediaConfig(db);
}

export interface StreamGrant {
  token: string;
  trackId: string;
  userId: string | null;
  expiresAt: number;
}

export function deleteExpiredQueues(db: Database): number {
  const rows = db
    .prepare(
      `SELECT id FROM media_lists
        WHERE kind = 'queue' AND expires_at IS NOT NULL AND expires_at < datetime('now')
        ORDER BY expires_at LIMIT 100`,
    )
    .all() as Array<{ id: string }>;
  for (const row of rows) {
    // Explicit item deletion runs the ref_count decrement triggers.
    db.prepare("DELETE FROM media_list_items WHERE list_id = ?").run(row.id);
    db.prepare("DELETE FROM media_lists WHERE id = ?").run(row.id);
  }
  return rows.length;
}

export function insertStreamGrant(db: Database, grant: StreamGrant): void {
  db.prepare(
    `INSERT INTO media_stream_grants (token, track_id, user_id, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(grant.token, grant.trackId, grant.userId, grant.expiresAt, Date.now());
}

/** Generate and insert a short-lived grant used by the raw audio HTTP route. */
export function issueStreamGrant(
  db: Database,
  trackId: string,
  userId: string | null,
  ttlMs = 10 * 60_000,
): { token: string; expiresAt: number } {
  const token = crypto.randomBytes(24).toString("base64url");
  const expiresAt = Date.now() + ttlMs;
  insertStreamGrant(db, { token, trackId, userId, expiresAt });
  return { token, expiresAt };
}

export function consumeStreamGrant(
  db: Database,
  token: string,
  now = Date.now(),
): StreamGrant | null {
  return db.transaction(() => {
    const row = db
      .prepare(
        `SELECT token, track_id, user_id, expires_at
           FROM media_stream_grants WHERE token = ?`,
      )
      .get(token) as
      | {
          token: string;
          track_id: string;
          user_id: string | null;
          expires_at: number;
        }
      | undefined;
    if (!row) return null;
    db.prepare("DELETE FROM media_stream_grants WHERE token = ?").run(token);
    if (row.expires_at <= now) return null;
    return {
      token: row.token,
      trackId: row.track_id,
      userId: row.user_id,
      expiresAt: row.expires_at,
    };
  })();
}

export function deleteExpiredStreamGrants(db: Database): number {
  const result = db
    .prepare("DELETE FROM media_stream_grants WHERE expires_at < ?")
    .run(Date.now());
  return result.changes;
}
