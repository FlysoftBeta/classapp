import type { Database } from "better-sqlite3";
import type { Article, ArticleWithMeta } from "@/shared/types/api";
import {
  READING_HISTORY_LIMIT,
  READING_HISTORY_MIN_SECONDS,
  SEGMENT_SIZE,
} from "@/shared/types/api/article";

const META_COLUMNS = `
  a.id, a.user_id, a.group_id, a.title, a.content_kind, a.blob_path, a.mime_type,
  a.file_size, a.original_filename, a.created_at,
  COALESCE(u.username, du.username) AS username, u.handle,
  CASE WHEN a.content_kind = 'blob' THEN a.file_size ELSE length(a.content) END AS content_length,
  (SELECT bookmarked FROM article_bookmarks WHERE user_id = :uid AND article_id = a.id) AS is_bookmarked,
  (SELECT updated_at_ms FROM article_bookmarks WHERE user_id = :uid AND article_id = a.id) AS bookmark_updated_at_ms,
  (SELECT offset FROM article_read_progress WHERE user_id = :uid AND article_id = a.id) AS current_offset,
  (SELECT updated_at_ms FROM article_read_progress WHERE user_id = :uid AND article_id = a.id) AS current_offset_updated_at,
  (SELECT locator FROM article_read_progress WHERE user_id = :uid AND article_id = a.id) AS current_locator,
  (SELECT total_read_seconds FROM article_read_progress WHERE user_id = :uid AND article_id = a.id) AS total_read_seconds,
  (SELECT updated_at FROM article_read_progress WHERE user_id = :uid AND article_id = a.id) AS last_read_at`;
const FROM_ARTICLES = ` FROM articles a
  LEFT JOIN users u ON a.user_id = u.id
    AND NOT EXISTS (SELECT 1 FROM deleted_users x WHERE x.id = u.id)
  LEFT JOIN deleted_users du ON a.user_id = du.id `;

export interface ArticleRecord {
  id: string;
  user_id: string | null;
  group_id: string;
  title: string;
  content: string;
  content_kind: string;
  blob_path: string | null;
  mime_type: string | null;
  file_size: number;
  original_filename: string | null;
  created_at: string;
}

export interface ArticleAccessRow {
  user_id: string | null;
  group_id: string;
}

export function purgeArticlesForUser(db: Database, userId: string): string[] {
  const blobPaths = (
    db
      .prepare(
        `SELECT blob_path FROM articles
         WHERE user_id = ? AND content_kind = 'blob' AND blob_path IS NOT NULL`,
      )
      .all(userId) as { blob_path: string }[]
  ).map((row) => row.blob_path);
  db.transaction(() => {
    db.prepare("DELETE FROM article_bookmarks WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM article_read_progress WHERE user_id = ?").run(
      userId,
    );
    db.prepare("DELETE FROM articles WHERE user_id = ?").run(userId);
  })();
  return blobPaths;
}

export function rowToArticle(
  row: Record<string, unknown>,
): Article & ArticleWithMeta {
  return {
    ...row,
    is_bookmarked: !!row.is_bookmarked,
    bookmark_updated_at_ms: (row.bookmark_updated_at_ms as number | null) ?? 0,
    current_offset: (row.current_offset as number | null) ?? 0,
    current_offset_updated_at:
      (row.current_offset_updated_at as number | null) ?? 0,
    total_read_seconds: (row.total_read_seconds as number | null) ?? 0,
    last_read_at: (row.last_read_at as string | null) ?? null,
    content_length:
      (row.content_length as number | null) ??
      ((row.content as string) ?? "").length,
    file_size: (row.file_size as number | null) ?? 0,
    content_kind: (row.content_kind as "text" | "blob" | null) ?? "text",
  } as Article & ArticleWithMeta;
}

export function findArticleForUser(
  db: Database,
  articleId: string,
  userId: string,
) {
  const row = db
    .prepare(
      `SELECT ${META_COLUMNS}, a.content ${FROM_ARTICLES} WHERE a.id = :id`,
    )
    .get({ id: articleId, uid: userId }) as Record<string, unknown> | undefined;
  return row ? rowToArticle(row) : null;
}

export function findArticleRecord(
  db: Database,
  articleId: string,
): ArticleRecord | null {
  return (
    (db
      .prepare(
        `SELECT id, user_id, group_id, title, content, content_kind, blob_path, mime_type,
            file_size, original_filename, created_at FROM articles WHERE id = ?`,
      )
      .get(articleId) as ArticleRecord | undefined) ?? null
  );
}

export function findArticleAccessRow(
  db: Database,
  articleId: string,
): ArticleAccessRow | null {
  return (
    (db
      .prepare("SELECT user_id, group_id FROM articles WHERE id = ?")
      .get(articleId) as ArticleAccessRow | undefined) ?? null
  );
}

export function insertTextArticle(
  db: Database,
  input: {
    id: string;
    userId: string;
    groupId: string;
    title: string;
    content: string;
  },
): void {
  db.prepare(
    "INSERT INTO articles (id, user_id, group_id, title, content) VALUES (?, ?, ?, ?, ?)",
  ).run(input.id, input.userId, input.groupId, input.title, input.content);
}

export function insertBlobArticle(
  db: Database,
  input: {
    id: string;
    userId: string;
    groupId: string;
    title: string;
    blobPath: string;
    mimeType: string;
    fileSize: number;
    originalFilename: string;
  },
): void {
  db.prepare(
    `INSERT INTO articles
    (id, user_id, group_id, title, content, content_kind, blob_path, mime_type, file_size, original_filename)
    VALUES (?, ?, ?, ?, '', 'blob', ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.userId,
    input.groupId,
    input.title,
    input.blobPath,
    input.mimeType,
    input.fileSize,
    input.originalFilename,
  );
}

export function listArticlesForUser(
  db: Database,
  userId: string,
  options: {
    bookmarkedOnly?: boolean;
    offset?: number;
    groupId?: string;
  },
): { articles: (Article & ArticleWithMeta)[]; total: number } {
  const { bookmarkedOnly = false, offset = 0, groupId } = options;
  let where = groupId
    ? "WHERE a.group_id = :groupId AND EXISTS (SELECT 1 FROM user_groups ug WHERE ug.user_id = :uid AND ug.group_id = a.group_id)"
    : `WHERE EXISTS (
        SELECT 1 FROM user_groups ug
        WHERE ug.user_id = :uid AND ug.group_id = a.group_id
      )`;
  if (bookmarkedOnly)
    where +=
      " AND (SELECT bookmarked FROM article_bookmarks WHERE user_id = :uid AND article_id = a.id) = 1";
  const order = bookmarkedOnly
    ? `ORDER BY COALESCE((SELECT updated_at FROM article_read_progress WHERE user_id = :uid AND article_id = a.id), (SELECT created_at FROM article_bookmarks WHERE user_id = :uid AND article_id = a.id)) DESC`
    : "ORDER BY a.created_at DESC";
  const rows = db
    .prepare(
      `SELECT ${META_COLUMNS} ${FROM_ARTICLES} ${where} ${order} LIMIT 50 OFFSET :off`,
    )
    .all({ uid: userId, groupId: groupId ?? null, off: offset }) as Record<
    string,
    unknown
  >[];
  const total = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM articles a ${where}`)
      .get({ uid: userId, groupId: groupId ?? null }) as { n: number }
  ).n;
  return { articles: rows.map(rowToArticle), total };
}

export function listArticleHistoryRows(
  db: Database,
  userId: string,
): Record<string, unknown>[] {
  return db
    .prepare(
      `SELECT ${META_COLUMNS} ${FROM_ARTICLES}
    JOIN article_read_progress rp ON rp.article_id = a.id AND rp.user_id = :uid
    WHERE EXISTS (
      SELECT 1 FROM user_groups ug
      WHERE ug.user_id = :uid AND ug.group_id = a.group_id
    ) AND rp.total_read_seconds >= :minSec
    ORDER BY rp.updated_at DESC LIMIT :limit`,
    )
    .all({
      uid: userId,
      minSec: READING_HISTORY_MIN_SECONDS,
      limit: READING_HISTORY_LIMIT,
    }) as Record<string, unknown>[];
}

export function listBookmarkedArticleRows(
  db: Database,
  userId: string,
): Record<string, unknown>[] {
  return db
    .prepare(
      `SELECT ${META_COLUMNS} ${FROM_ARTICLES}
    JOIN article_bookmarks ab ON ab.article_id = a.id AND ab.user_id = :uid AND ab.bookmarked = 1
    WHERE EXISTS (
      SELECT 1 FROM user_groups ug
      WHERE ug.user_id = :uid AND ug.group_id = a.group_id
    )
    ORDER BY COALESCE((SELECT updated_at FROM article_read_progress WHERE user_id = :uid AND article_id = a.id), ab.created_at) DESC`,
    )
    .all({ uid: userId }) as Record<string, unknown>[];
}

export function setArticleBookmarkValue(
  db: Database,
  userId: string,
  articleId: string,
  bookmarked: boolean,
  updatedAt: number,
) {
  db.prepare(
    `INSERT INTO article_bookmarks (user_id, article_id, bookmarked, updated_at_ms, created_at)
    VALUES (?, ?, ?, ?, datetime('now')) ON CONFLICT(user_id, article_id) DO UPDATE SET
    bookmarked = excluded.bookmarked, updated_at_ms = excluded.updated_at_ms,
    created_at = CASE WHEN excluded.bookmarked = 1 THEN datetime('now') ELSE article_bookmarks.created_at END
    WHERE excluded.updated_at_ms >= article_bookmarks.updated_at_ms`,
  ).run(userId, articleId, bookmarked ? 1 : 0, updatedAt);
  const row = db
    .prepare(
      `SELECT bookmarked AS value, updated_at_ms AS updatedAt FROM article_bookmarks WHERE user_id = ? AND article_id = ?`,
    )
    .get(userId, articleId) as { value: number; updatedAt: number } | undefined;
  return row
    ? { value: !!row.value, updatedAt: row.updatedAt }
    : { value: false, updatedAt: 0 };
}

export function upsertArticleProgressOffset(
  db: Database,
  userId: string,
  articleId: string,
  offset: number,
  updatedAt: number,
) {
  db.prepare(
    `INSERT INTO article_read_progress (user_id, article_id, offset, updated_at, updated_at_ms)
    VALUES (?, ?, ?, datetime('now'), ?) ON CONFLICT(user_id, article_id) DO UPDATE SET
    offset = excluded.offset, updated_at = excluded.updated_at, updated_at_ms = excluded.updated_at_ms
    WHERE excluded.updated_at_ms >= article_read_progress.updated_at_ms`,
  ).run(userId, articleId, offset, updatedAt);
  return getArticleProgressOffset(db, userId, articleId);
}

export function getArticleProgressOffset(
  db: Database,
  userId: string,
  articleId: string,
) {
  return (
    (db
      .prepare(
        `SELECT offset, updated_at_ms AS updatedAt FROM article_read_progress WHERE user_id = ? AND article_id = ?`,
      )
      .get(userId, articleId) as
      { offset: number; updatedAt: number } | undefined) ?? {
      offset: 0,
      updatedAt: 0,
    }
  );
}

export function addArticleProgressSeconds(
  db: Database,
  userId: string,
  articleId: string,
  seconds: number,
): void {
  db.prepare(
    `INSERT INTO article_read_progress (user_id, article_id, offset, total_read_seconds, updated_at)
    VALUES (?, ?, 0, ?, datetime('now')) ON CONFLICT(user_id, article_id) DO UPDATE SET
    total_read_seconds = article_read_progress.total_read_seconds + excluded.total_read_seconds, updated_at = datetime('now')`,
  ).run(userId, articleId, seconds);
}

export function touchArticleProgress(
  db: Database,
  userId: string,
  articleId: string,
): void {
  db.prepare(
    `INSERT INTO article_read_progress (user_id, article_id, offset, total_read_seconds, updated_at)
    VALUES (?, ?, 0, 0, datetime('now')) ON CONFLICT(user_id, article_id) DO UPDATE SET updated_at = datetime('now')`,
  ).run(userId, articleId);
}

export function deleteArticleById(db: Database, articleId: string): void {
  db.prepare("DELETE FROM articles WHERE id = ?").run(articleId);
}

export function getArticleTextSegment(
  db: Database,
  articleId: string,
  offset: number,
) {
  const article = db
    .prepare("SELECT content, content_kind FROM articles WHERE id = ?")
    .get(articleId) as { content: string; content_kind: string } | undefined;
  if (!article) return null;
  const contentLength = article.content.length;
  const clampedOffset = Math.max(0, Math.min(offset, contentLength));
  return {
    content: article.content.slice(clampedOffset, clampedOffset + SEGMENT_SIZE),
    content_kind: article.content_kind,
    content_length: contentLength,
    clamped_offset: clampedOffset,
    has_more: clampedOffset + SEGMENT_SIZE < contentLength,
  };
}
