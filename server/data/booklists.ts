import crypto from "node:crypto";
import type { Database } from "better-sqlite3";
import { EMPTY_ACCESS_FLAGS, type AccessFlags } from "@/shared/access";
import type { ArticleWithMeta } from "@/shared/types/api";

export interface BooklistSummary {
  id: string;
  title: string;
  revision: number;
  created_at: string;
  updated_at: string;
  item_count: number;
  origin_group_id: string | null;
  access: AccessFlags;
}

export interface BooklistItemRow {
  article_id: string;
  position: number;
  added_at: string;
}

export interface BooklistContents {
  list: BooklistSummary;
  items: BooklistItemRow[];
}

const LIST_SELECT = `
  SELECT l.id, l.title, l.revision, l.created_at, l.updated_at, l.origin_group_id,
         (SELECT COUNT(*) FROM booklist_items i WHERE i.list_id = l.id) AS item_count
    FROM media_lists l`;

function summaryFromRow(row: Record<string, unknown>): BooklistSummary {
  return {
    id: String(row.id),
    title: String(row.title),
    revision: Number(row.revision),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    item_count: Number(row.item_count ?? 0),
    origin_group_id:
      typeof row.origin_group_id === "string" ? row.origin_group_id : null,
    access: EMPTY_ACCESS_FLAGS,
  };
}

export function createBooklistRow(
  db: Database,
  title: string,
  originGroupId: string | null = null,
): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO media_lists (id, kind, title, origin_group_id)
     VALUES (?, 'booklist', ?, ?)`,
  ).run(id, title, originGroupId);
  return id;
}

export function findGroupBooklistId(
  db: Database,
  groupId: string,
): string | null {
  const row = db
    .prepare(
      `SELECT id FROM media_lists
        WHERE kind = 'booklist' AND origin_group_id = ?`,
    )
    .get(groupId) as { id: string } | undefined;
  return row?.id ?? null;
}

export function listBooklistsByIds(
  db: Database,
  listIds: string[],
): BooklistSummary[] {
  if (listIds.length === 0) return [];
  const placeholders = listIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `${LIST_SELECT} WHERE kind = 'booklist' AND id IN (${placeholders})
       ORDER BY updated_at DESC`,
    )
    .all(...listIds) as Array<Record<string, unknown>>;
  return rows.map(summaryFromRow);
}

export function booklistContents(db: Database, listId: string): BooklistContents {
  const row = db
    .prepare(`${LIST_SELECT} WHERE kind = 'booklist' AND id = ?`)
    .get(listId) as Record<string, unknown> | undefined;
  if (!row) throw new Error("booklist not found");
  const items = db
    .prepare(
      `SELECT article_id, position, added_at
         FROM booklist_items WHERE list_id = ? ORDER BY position`,
    )
    .all(listId) as BooklistItemRow[];
  return { list: summaryFromRow(row), items };
}

function touchBooklist(db: Database, listId: string): void {
  db.prepare(
    `UPDATE media_lists SET revision = revision + 1, updated_at = datetime('now')
      WHERE id = ?`,
  ).run(listId);
}

export function addBooklistItem(
  db: Database,
  listId: string,
  articleId: string,
): BooklistContents {
  booklistContents(db, listId);
  const existing = db
    .prepare(
      "SELECT 1 FROM booklist_items WHERE list_id = ? AND article_id = ?",
    )
    .get(listId, articleId);
  if (!existing) {
    const position = db
      .prepare(
        "SELECT COALESCE(MAX(position), -1) + 1 AS position FROM booklist_items WHERE list_id = ?",
      )
      .get(listId) as { position: number };
    db.prepare(
      "INSERT INTO booklist_items (list_id, position, article_id) VALUES (?, ?, ?)",
    ).run(listId, position.position, articleId);
    touchBooklist(db, listId);
  }
  return booklistContents(db, listId);
}

export function removeBooklistItem(
  db: Database,
  listId: string,
  articleId: string,
): BooklistContents {
  booklistContents(db, listId);
  db.prepare(
    "DELETE FROM booklist_items WHERE list_id = ? AND article_id = ?",
  ).run(listId, articleId);
  const rows = db
    .prepare(
      "SELECT article_id, position FROM booklist_items WHERE list_id = ? ORDER BY position",
    )
    .all(listId) as Array<{ article_id: string; position: number }>;
  const update = db.prepare(
    "UPDATE booklist_items SET position = ? WHERE list_id = ? AND article_id = ?",
  );
  rows.forEach((row, index) => {
    if (row.position !== index) update.run(index, listId, row.article_id);
  });
  touchBooklist(db, listId);
  return booklistContents(db, listId);
}

export function deleteBooklist(db: Database, listId: string): void {
  booklistContents(db, listId);
  db.prepare("DELETE FROM booklist_items WHERE list_id = ?").run(listId);
  db.prepare("DELETE FROM media_lists WHERE id = ?").run(listId);
}

export function articleIdsForBooklist(db: Database, listId: string): string[] {
  return booklistContents(db, listId).items.map((item) => item.article_id);
}

export type { ArticleWithMeta };
