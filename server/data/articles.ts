import type { Database } from "better-sqlite3";
import type { Article, ArticleWithMeta } from "@/shared/types/api";
import {
  READING_HISTORY_LIMIT,
  READING_HISTORY_MIN_SECONDS,
  SEGMENT_SIZE,
} from "@/shared/types/api/article";
import { splitTextArticle } from "@/shared/articles/segments";

type TextProvider = { type: "text"; words: number; chunks: number };
export type BundleProvider = {
  type: "bundle";
  source_file: string;
  archive_file: string;
  source_mime: string;
  source_bytes: number;
  archive_bytes: number;
  original_name?: string | null;
  items: number;
};
type ArticleProvider = TextProvider | BundleProvider;

const META_COLUMNS = `
  a.id, a.user_id, a.group_id, a.title, a.provider_json, a.created_at,
  COALESCE(u.username, du.username) AS username, u.handle,
  ab.bookmarked AS is_bookmarked,
  ab.updated_at_ms AS bookmark_updated_at_ms,
  rp.offset AS current_offset,
  rp.updated_at_ms AS current_offset_updated_at,
  rp.locator AS current_locator,
  rp.total_read_seconds AS total_read_seconds,
  rp.updated_at AS last_read_at`;
const ARTICLE_AUTHOR_JOINS = `
  LEFT JOIN users u ON a.user_id = u.id
    AND NOT EXISTS (SELECT 1 FROM deleted_users x WHERE x.id = u.id)
  LEFT JOIN deleted_users du ON a.user_id = du.id`;
const FROM_ARTICLES = ` FROM articles a
  LEFT JOIN article_bookmarks ab ON ab.user_id = :uid AND ab.article_id = a.id
  LEFT JOIN article_read_progress rp ON rp.user_id = :uid AND rp.article_id = a.id
  ${ARTICLE_AUTHOR_JOINS}`;
const FROM_BOOKMARKED_ARTICLES = ` FROM article_bookmarks ab
  JOIN articles a ON a.id = ab.article_id
  LEFT JOIN article_read_progress rp ON rp.user_id = :uid AND rp.article_id = a.id
  ${ARTICLE_AUTHOR_JOINS}`;

export interface ArticleRecord {
  id: string;
  user_id: string | null;
  group_id: string;
  title: string;
  provider: ArticleProvider;
  content_kind: "text" | "bundle";
  source_path: string | null;
  archive_path: string | null;
  mime_type: string | null;
  file_size: number;
  original_filename: string | null;
  content_length: number;
  created_at: string;
}

export interface ArticleAccessRow {
  user_id: string | null;
  group_id: string;
}

export type ArticleListView = "all" | "bookmarked" | "recent";
export interface ArticleListCursor {
  sortAt: string;
  id: string;
}

function nonnegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Invalid article provider field: ${field}`);
  }
  return value as number;
}

function parseProvider(raw: unknown): ArticleProvider {
  const value =
    typeof raw === "string"
      ? (JSON.parse(raw) as ArticleProvider)
      : (raw as ArticleProvider);
  if (value?.type === "text") {
    return {
      type: "text",
      words: nonnegativeInteger(value.words, "words"),
      chunks: nonnegativeInteger(value.chunks, "chunks"),
    };
  }
  if (value?.type === "bundle") {
    return {
      ...value,
      source_file: value.source_file || "",
      archive_file: value.archive_file || "",
      source_mime: value.source_mime || "application/octet-stream",
      source_bytes: nonnegativeInteger(value.source_bytes, "source_bytes"),
      archive_bytes: nonnegativeInteger(value.archive_bytes, "archive_bytes"),
      items: nonnegativeInteger(value.items, "items"),
    };
  }
  throw new Error("Invalid article provider metadata");
}

function providerReadModel(provider: ArticleProvider) {
  return provider.type === "text"
    ? {
        content_kind: "text" as const,
        source_path: null,
        archive_path: null,
        mime_type: null,
        file_size: 0,
        original_filename: null,
        content_length: provider.words,
      }
    : {
        content_kind: "bundle" as const,
        source_path: provider.source_file,
        archive_path: provider.archive_file,
        mime_type: provider.source_mime,
        file_size: provider.source_bytes,
        original_filename: provider.original_name ?? null,
        content_length: provider.items,
      };
}

export function rowToArticle(
  row: Record<string, unknown>,
): Article & ArticleWithMeta {
  const provider = parseProvider(row.provider_json ?? row.provider);
  return {
    id: String(row.id),
    user_id: typeof row.user_id === "string" ? row.user_id : null,
    group_id: String(row.group_id),
    title: String(row.title),
    provider,
    ...providerReadModel(provider),
    created_at: String(row.created_at),
    username: typeof row.username === "string" ? row.username : null,
    handle: typeof row.handle === "string" ? row.handle : null,
    ...(typeof row.content === "string" ? { content: row.content } : {}),
    is_bookmarked: !!row.is_bookmarked,
    bookmark_updated_at_ms: (row.bookmark_updated_at_ms as number | null) ?? 0,
    current_offset: (row.current_offset as number | null) ?? 0,
    current_offset_updated_at:
      (row.current_offset_updated_at as number | null) ?? 0,
    current_locator:
      typeof row.current_locator === "string" ? row.current_locator : null,
    total_read_seconds: (row.total_read_seconds as number | null) ?? 0,
    last_read_at: (row.last_read_at as string | null) ?? null,
    ...(typeof row.list_sort_at === "string"
      ? { list_sort_at: row.list_sort_at }
      : {}),
  } as Article & ArticleWithMeta;
}

export function purgeArticlesForUser(
  db: Database,
  userId: string,
): Array<{ sourcePath: string; archivePath: string }> {
  const artifacts = (
    db
      .prepare(
        `SELECT provider_json FROM articles WHERE user_id = ? AND json_extract(provider_json, '$.type') = 'bundle'`,
      )
      .all(userId) as Array<{ provider_json: string }>
  ).map((row) => {
    const provider = parseProvider(row.provider_json) as BundleProvider;
    return {
      sourcePath: provider.source_file,
      archivePath: provider.archive_file,
    };
  });
  db.transaction(() => {
    db.prepare("DELETE FROM article_bookmarks WHERE user_id = ?").run(userId);
    db.prepare("DELETE FROM article_read_progress WHERE user_id = ?").run(
      userId,
    );
    db.prepare("DELETE FROM articles WHERE user_id = ?").run(userId);
  })();
  return artifacts;
}

export function findArticleForUser(
  db: Database,
  articleId: string,
  userId: string,
) {
  const row = db
    .prepare(`SELECT ${META_COLUMNS} ${FROM_ARTICLES} WHERE a.id = :id`)
    .get({ id: articleId, uid: userId }) as Record<string, unknown> | undefined;
  return row ? rowToArticle(row) : null;
}

export function findArticleRecord(
  db: Database,
  articleId: string,
): ArticleRecord | null {
  const row = db
    .prepare(
      "SELECT id, user_id, group_id, title, provider_json, created_at FROM articles WHERE id = ?",
    )
    .get(articleId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const provider = parseProvider(row.provider_json);
  return {
    ...(row as Omit<
      ArticleRecord,
      | "provider"
      | "content_kind"
      | "source_path"
      | "archive_path"
      | "mime_type"
      | "file_size"
      | "original_filename"
      | "content_length"
    >),
    provider,
    ...providerReadModel(provider),
  };
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
  const segments = splitTextArticle(input.content, SEGMENT_SIZE);
  const insertSegment = db.prepare(
    `INSERT INTO text_article_segments (article_id, segment_index, start_offset, char_count, content)
     VALUES (?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    db.prepare(
      "INSERT INTO articles (id, user_id, group_id, title, provider_json) VALUES (?, ?, ?, ?, ?)",
    ).run(
      input.id,
      input.userId,
      input.groupId,
      input.title,
      JSON.stringify({
        type: "text",
        words: input.content.length,
        chunks: segments.length,
      }),
    );
    for (const segment of segments) {
      insertSegment.run(
        input.id,
        segment.index,
        segment.startOffset,
        segment.content.length,
        segment.content,
      );
    }
  })();
}

export function insertBundleArticle(
  db: Database,
  input: {
    id: string;
    userId: string;
    groupId: string;
    title: string;
    sourcePath: string;
    archivePath: string;
    sourceMime: string;
    sourceSize: number;
    archiveSize: number;
    originalFilename: string;
    itemCount: number;
  },
): void {
  db.prepare(
    "INSERT INTO articles (id, user_id, group_id, title, provider_json) VALUES (?, ?, ?, ?, ?)",
  ).run(
    input.id,
    input.userId,
    input.groupId,
    input.title,
    JSON.stringify({
      type: "bundle",
      source_file: input.sourcePath,
      archive_file: input.archivePath,
      source_mime: input.sourceMime,
      source_bytes: input.sourceSize,
      archive_bytes: input.archiveSize,
      original_name: input.originalFilename,
      items: input.itemCount,
    }),
  );
}

function accessCondition(groupId?: string) {
  const membership =
    "EXISTS (SELECT 1 FROM group_members gm WHERE gm.user_id = :uid AND gm.group_id = a.group_id)";
  return groupId ? `a.group_id = :groupId AND ${membership}` : membership;
}

export function listArticlesForUser(
  db: Database,
  userId: string,
  options: {
    view?: ArticleListView;
    cursor?: ArticleListCursor;
    direction?: "before" | "after";
    groupId?: string;
  },
): { articles: (Article & ArticleWithMeta)[]; hasMore: boolean } {
  const view = options.view ?? "all";
  const direction = options.direction ?? "after";
  const from = view === "bookmarked" ? FROM_BOOKMARKED_ARTICLES : FROM_ARTICLES;
  let where = `WHERE ${accessCondition(options.groupId)}`;
  const sortAt =
    view === "bookmarked"
      ? "COALESCE(rp.updated_at, ab.created_at)"
      : view === "recent"
        ? "rp.updated_at"
        : "a.created_at";
  if (view === "bookmarked") where += " AND ab.bookmarked = 1";
  if (view === "recent")
    where += " AND rp.total_read_seconds >= :minReadSeconds";
  if (options.cursor) {
    const comparison = direction === "after" ? "<" : ">";
    where += ` AND (${sortAt} ${comparison} :cursorSortAt OR (${sortAt} = :cursorSortAt AND a.id ${comparison} :cursorId))`;
  }
  const orderDirection = direction === "after" ? "DESC" : "ASC";
  const params = {
    uid: userId,
    groupId: options.groupId ?? null,
    cursorSortAt: options.cursor?.sortAt ?? null,
    cursorId: options.cursor?.id ?? null,
    minReadSeconds: READING_HISTORY_MIN_SECONDS,
  };
  const rows = db
    .prepare(
      `SELECT ${META_COLUMNS}, ${sortAt} AS list_sort_at
       ${from} ${where}
       ORDER BY ${sortAt} ${orderDirection}, a.id ${orderDirection}
       LIMIT 51`,
    )
    .all(params) as Record<string, unknown>[];
  const hasMore = rows.length > 50;
  const page = rows.slice(0, 50);
  if (direction === "before") page.reverse();
  return { articles: page.map(rowToArticle), hasMore };
}

export function listArticleHistoryRows(
  db: Database,
  userId: string,
): Record<string, unknown>[] {
  return db
    .prepare(
      `SELECT ${META_COLUMNS} ${FROM_ARTICLES}
     JOIN article_read_progress history_rp ON history_rp.article_id = a.id AND history_rp.user_id = :uid
     WHERE EXISTS (SELECT 1 FROM group_members gm WHERE gm.user_id = :uid AND gm.group_id = a.group_id)
       AND history_rp.total_read_seconds >= :minSec
     ORDER BY history_rp.updated_at DESC LIMIT :limit`,
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
     JOIN article_bookmarks bookmarked_ab ON bookmarked_ab.article_id = a.id AND bookmarked_ab.user_id = :uid AND bookmarked_ab.bookmarked = 1
     WHERE EXISTS (SELECT 1 FROM group_members gm WHERE gm.user_id = :uid AND gm.group_id = a.group_id)
     ORDER BY COALESCE(rp.updated_at, bookmarked_ab.created_at) DESC`,
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
      "SELECT bookmarked AS value, updated_at_ms AS updatedAt FROM article_bookmarks WHERE user_id = ? AND article_id = ?",
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
  merge: "override" | "furthest",
) {
  const current = getArticleProgressOffset(db, userId, articleId);
  if (merge === "furthest" && current.offset >= offset) return current;
  if (merge === "override" && current.updatedAt > updatedAt) return current;
  db.prepare(
    `INSERT INTO article_read_progress (user_id, article_id, offset, updated_at, updated_at_ms)
     VALUES (?, ?, ?, datetime('now'), ?) ON CONFLICT(user_id, article_id) DO UPDATE SET
       offset = excluded.offset, updated_at = excluded.updated_at, updated_at_ms = excluded.updated_at_ms`,
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
        "SELECT offset, updated_at_ms AS updatedAt FROM article_read_progress WHERE user_id = ? AND article_id = ?",
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
       total_read_seconds = article_read_progress.total_read_seconds + excluded.total_read_seconds,
       updated_at = datetime('now')`,
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
  const row = db
    .prepare("SELECT provider_json FROM articles WHERE id = ?")
    .get(articleId) as { provider_json: string } | undefined;
  if (!row) return null;
  const provider = parseProvider(row.provider_json);
  if (provider.type === "bundle") {
    return {
      content: "",
      content_kind: "bundle" as const,
      content_length: provider.items,
      clamped_offset: 0,
      has_more: false,
    };
  }
  const clamped = Math.max(0, Math.min(Math.floor(offset), provider.words));
  if (clamped === provider.words) {
    return {
      content: "",
      content_kind: "text" as const,
      content_length: provider.words,
      clamped_offset: clamped,
      has_more: false,
    };
  }
  const segment = db
    .prepare(
      `SELECT start_offset, content FROM text_article_segments
       WHERE article_id = ? AND start_offset <= ?
       ORDER BY start_offset DESC LIMIT 1`,
    )
    .get(articleId, clamped) as
    { start_offset: number; content: string } | undefined;
  if (!segment) return null;
  const content = segment.content.slice(clamped - segment.start_offset);
  return {
    content,
    content_kind: "text" as const,
    content_length: provider.words,
    clamped_offset: clamped,
    has_more: clamped + content.length < provider.words,
  };
}
