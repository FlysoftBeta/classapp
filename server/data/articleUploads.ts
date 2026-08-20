import type { Database } from "better-sqlite3";

export interface ArticleUploadRecord {
  id: string;
  user_id: string;
  booklist_id: string;
  status: "staging" | "published" | "abandoned";
  source_blob_id: string;
  archive_blob_id: string;
  source_bytes: number;
  archive_bytes: number;
}

export function insertArticleUpload(
  db: Database,
  input: {
    id: string;
    userId: string;
    booklistId: string;
    sourceBlobId: string;
    archiveBlobId: string;
  },
): void {
  db.prepare(
    `INSERT INTO article_uploads
       (id, user_id, booklist_id, status, source_blob_id, archive_blob_id)
     VALUES (?, ?, ?, 'staging', ?, ?)`,
  ).run(
    input.id,
    input.userId,
    input.booklistId,
    input.sourceBlobId,
    input.archiveBlobId,
  );
}

export function updateArticleUploadBytes(
  db: Database,
  id: string,
  input: { sourceBytes: number; archiveBytes: number },
): void {
  db.prepare(
    `UPDATE article_uploads SET source_bytes = ?, archive_bytes = ?,
       updated_at = datetime('now') WHERE id = ? AND status = 'staging'`,
  ).run(input.sourceBytes, input.archiveBytes, id);
}

export function publishArticleUpload(db: Database, id: string): void {
  db.prepare(
    `UPDATE article_uploads SET status = 'published',
       updated_at = datetime('now') WHERE id = ?`,
  ).run(id);
}

/** Publish only while staging and while the stored blob ids still match the row. */
export function claimArticleUpload(
  db: Database,
  id: string,
  sourceBlobId: string,
  archiveBlobId: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE article_uploads SET status = 'published',
         updated_at = datetime('now')
       WHERE id = ? AND status = 'staging'
         AND source_blob_id = ? AND archive_blob_id = ?`,
    )
    .run(id, sourceBlobId, archiveBlobId);
  return result.changes > 0;
}

export function abandonArticleUpload(db: Database, id: string): void {
  db.prepare(
    `UPDATE article_uploads SET status = 'abandoned',
       updated_at = datetime('now') WHERE id = ?`,
  ).run(id);
}

export function listStaleArticleUploads(
  db: Database,
  olderThan: string,
): ArticleUploadRecord[] {
  return db
    .prepare(
      `SELECT id, user_id, group_id, status, source_blob_id, archive_blob_id,
              source_bytes, archive_bytes
         FROM article_uploads
        WHERE status = 'staging' AND created_at < ?
        ORDER BY created_at LIMIT 100`,
    )
    .all(olderThan) as ArticleUploadRecord[];
}
