import type { Database } from "better-sqlite3";
import type { PostImageThumb, PostImageThumbState } from "@/shared/types/api";

export interface PostImageRow {
  id: string;
  postId: string | null;
  blobId: string;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  sha256: string;
  createdAt: string;
}

export interface PostImageThumbRow {
  imageId: string;
  blobId: string | null;
  mime: string | null;
  bytes: number;
  width: number;
  height: number;
  sha256: string | null;
  state: PostImageThumbState;
  generation: number;
  updatedAt: string;
}

export interface PostImageRecord extends PostImageRow {
  thumb: PostImageThumbRow;
}

interface ImageSqlRow {
  id: string;
  post_id: string | null;
  blob_id: string;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  sha256: string;
  created_at: string;
  thumb_blob_id: string | null;
  thumb_mime: string | null;
  thumb_bytes: number | null;
  thumb_width: number | null;
  thumb_height: number | null;
  thumb_sha256: string | null;
  thumb_state: PostImageThumbState | null;
  thumb_generation: number | null;
  thumb_updated_at: string | null;
}

const IMAGE_SELECT = `
  SELECT i.id, i.post_id, i.blob_id, i.mime, i.bytes, i.width, i.height, i.sha256,
         i.created_at,
         t.blob_id AS thumb_blob_id, t.mime AS thumb_mime, t.bytes AS thumb_bytes,
         t.width AS thumb_width, t.height AS thumb_height, t.sha256 AS thumb_sha256,
         t.state AS thumb_state, t.generation AS thumb_generation,
         t.updated_at AS thumb_updated_at
    FROM post_images i
    LEFT JOIN post_image_thumbs t ON t.image_id = i.id`;

function emptyThumb(imageId: string): PostImageThumbRow {
  return {
    imageId,
    blobId: null,
    mime: null,
    bytes: 0,
    width: 0,
    height: 0,
    sha256: null,
    state: "absent",
    generation: 0,
    updatedAt: "",
  };
}

function rowToImage(row: ImageSqlRow): PostImageRecord {
  return {
    id: row.id,
    postId: row.post_id,
    blobId: row.blob_id,
    mime: row.mime,
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    sha256: row.sha256,
    createdAt: row.created_at,
    thumb: row.thumb_state
      ? {
          imageId: row.id,
          blobId: row.thumb_blob_id,
          mime: row.thumb_mime,
          bytes: row.thumb_bytes ?? 0,
          width: row.thumb_width ?? 0,
          height: row.thumb_height ?? 0,
          sha256: row.thumb_sha256,
          state: row.thumb_state,
          generation: row.thumb_generation ?? 0,
          updatedAt: row.thumb_updated_at ?? "",
        }
      : emptyThumb(row.id),
  };
}

export function thumbToWire(thumb: PostImageThumbRow): PostImageThumb {
  return {
    state: thumb.state,
    mime: thumb.mime,
    bytes: thumb.bytes,
    width: thumb.width,
    height: thumb.height,
    sha256: thumb.sha256,
  };
}

export function insertStagingPostImage(
  db: Database,
  input: {
    id: string;
    blobId: string;
    mime: string;
    bytes: number;
    width: number;
    height: number;
    sha256: string;
  },
): void {
  db.prepare(
    `INSERT INTO post_images
       (id, post_id, blob_id, mime, bytes, width, height, sha256)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.blobId,
    input.mime,
    input.bytes,
    input.width,
    input.height,
    input.sha256,
  );
}

export function attachPostImage(
  db: Database,
  imageId: string,
  postId: string,
): boolean {
  const updated = db
    .prepare(
      `UPDATE post_images SET post_id = ?
        WHERE id = ? AND post_id IS NULL`,
    )
    .run(postId, imageId);
  if (updated.changes !== 1) return false;
  db.prepare(
    `INSERT INTO post_image_thumbs (image_id, state)
     VALUES (?, 'absent')`,
  ).run(imageId);
  return true;
}

export function getPostImage(db: Database, imageId: string): PostImageRecord | null {
  const row = db.prepare(`${IMAGE_SELECT} WHERE i.id = ?`).get(imageId) as
    | ImageSqlRow
    | undefined;
  return row ? rowToImage(row) : null;
}

export function getPostImageByPostId(
  db: Database,
  postId: string,
): PostImageRecord | null {
  const row = db.prepare(`${IMAGE_SELECT} WHERE i.post_id = ?`).get(postId) as
    | ImageSqlRow
    | undefined;
  return row ? rowToImage(row) : null;
}

export function listPostImagesByIds(
  db: Database,
  imageIds: readonly string[],
): Map<string, PostImageRecord> {
  const found = new Map<string, PostImageRecord>();
  if (imageIds.length === 0) return found;
  const placeholders = imageIds.map(() => "?").join(", ");
  const rows = db
    .prepare(`${IMAGE_SELECT} WHERE i.id IN (${placeholders})`)
    .all(...imageIds) as ImageSqlRow[];
  for (const row of rows) found.set(row.id, rowToImage(row));
  return found;
}

export function deleteStagingPostImage(db: Database, imageId: string): string | null {
  const row = db
    .prepare(
      `SELECT blob_id FROM post_images WHERE id = ? AND post_id IS NULL`,
    )
    .get(imageId) as { blob_id: string } | undefined;
  if (!row) return null;
  db.prepare("DELETE FROM post_images WHERE id = ?").run(imageId);
  return row.blob_id;
}

export function listStaleStagingPostImages(
  db: Database,
  olderThan: string,
): PostImageRecord[] {
  const rows = db
    .prepare(
      `${IMAGE_SELECT}
        WHERE i.post_id IS NULL AND i.created_at < ?
        ORDER BY i.created_at LIMIT 50`,
    )
    .all(olderThan) as ImageSqlRow[];
  return rows.map(rowToImage);
}

export function listDeletedPostImages(db: Database, limit = 50): PostImageRecord[] {
  const rows = db
    .prepare(
      `${IMAGE_SELECT}
        WHERE i.post_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM posts p
             WHERE p.id = i.post_id AND p.deleted_at IS NOT NULL
          )
        ORDER BY i.created_at LIMIT ?`,
    )
    .all(limit) as ImageSqlRow[];
  return rows.map(rowToImage);
}

export function detachPostImage(
  db: Database,
  imageId: string,
): { originalBlobId: string; thumbBlobId: string | null } | null {
  const row = getPostImage(db, imageId);
  if (!row) return null;
  db.prepare("DELETE FROM post_image_thumbs WHERE image_id = ?").run(imageId);
  db.prepare("DELETE FROM post_images WHERE id = ?").run(imageId);
  return { originalBlobId: row.blobId, thumbBlobId: row.thumb.blobId };
}

export function markThumbStaging(
  db: Database,
  imageId: string,
): PostImageThumbRow | null {
  db.prepare(
    `INSERT INTO post_image_thumbs (image_id, state, generation, updated_at)
     VALUES (?, 'staging', 1, datetime('now'))
     ON CONFLICT(image_id) DO UPDATE SET
       state = 'staging',
       generation = post_image_thumbs.generation + 1,
       blob_id = NULL,
       mime = NULL,
       bytes = 0,
       width = 0,
       height = 0,
       sha256 = NULL,
       updated_at = datetime('now')
     WHERE post_image_thumbs.state IN ('absent', 'failed')`,
  ).run(imageId);
  const image = getPostImage(db, imageId);
  if (!image || image.thumb.state !== "staging") return null;
  return image.thumb;
}

export function publishThumb(
  db: Database,
  imageId: string,
  generation: number,
  input: {
    blobId: string;
    mime: string;
    bytes: number;
    width: number;
    height: number;
    sha256: string;
  },
): boolean {
  const updated = db
    .prepare(
      `UPDATE post_image_thumbs
          SET blob_id = ?, mime = ?, bytes = ?, width = ?, height = ?, sha256 = ?,
              state = 'ready', updated_at = datetime('now')
        WHERE image_id = ? AND generation = ? AND state = 'staging'`,
    )
    .run(
      input.blobId,
      input.mime,
      input.bytes,
      input.width,
      input.height,
      input.sha256,
      imageId,
      generation,
    );
  return updated.changes === 1;
}

export function markThumbFailed(
  db: Database,
  imageId: string,
  generation: number,
): void {
  db.prepare(
    `UPDATE post_image_thumbs
        SET state = 'failed', blob_id = NULL, mime = NULL, bytes = 0,
            width = 0, height = 0, sha256 = NULL, updated_at = datetime('now')
      WHERE image_id = ? AND generation = ? AND state = 'staging'`,
  ).run(imageId, generation);
}

export function evictThumb(
  db: Database,
  imageId: string,
  expectedGeneration: number,
): string | null {
  const row = db
    .prepare(
      `SELECT blob_id, generation, state FROM post_image_thumbs WHERE image_id = ?`,
    )
    .get(imageId) as
    | { blob_id: string | null; generation: number; state: string }
    | undefined;
  if (!row || row.state !== "ready" || row.generation !== expectedGeneration) {
    return null;
  }
  db.prepare(
    `UPDATE post_image_thumbs
        SET state = 'absent', blob_id = NULL, mime = NULL, bytes = 0,
            width = 0, height = 0, sha256 = NULL, updated_at = datetime('now')
      WHERE image_id = ? AND generation = ? AND state = 'ready'`,
  ).run(imageId, expectedGeneration);
  return row.blob_id;
}
