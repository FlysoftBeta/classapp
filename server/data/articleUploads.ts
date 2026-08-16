import type { Database } from "better-sqlite3";

export interface ArticleUploadRecord {
  id: string;
  user_id: string;
  group_id: string;
  status: "staging" | "published" | "abandoned";
  source_key: string;
  archive_key: string;
  source_bytes: number;
  archive_bytes: number;
}

export function insertArticleUpload(
  db: Database,
  input: {
    id: string;
    userId: string;
    groupId: string;
    sourceKey: string;
    archiveKey: string;
  },
): void {
  db.prepare(
    `INSERT INTO article_uploads
       (id, user_id, group_id, status, source_key, archive_key)
     VALUES (?, ?, ?, 'staging', ?, ?)`,
  ).run(
    input.id,
    input.userId,
    input.groupId,
    input.sourceKey,
    input.archiveKey,
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

/** Publish only while staging and while the stored keys still match the row. */
export function claimArticleUpload(
  db: Database,
  id: string,
  sourceKey: string,
  archiveKey: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE article_uploads SET status = 'published',
         updated_at = datetime('now')
       WHERE id = ? AND status = 'staging'
         AND source_key = ? AND archive_key = ?`,
    )
    .run(id, sourceKey, archiveKey);
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
      `SELECT id, user_id, group_id, status, source_key, archive_key,
              source_bytes, archive_bytes
         FROM article_uploads
        WHERE status = 'staging' AND created_at < ?
        ORDER BY created_at LIMIT 100`,
    )
    .all(olderThan) as ArticleUploadRecord[];
}
