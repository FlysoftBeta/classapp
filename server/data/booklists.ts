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
  group_id: string | null;
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
  SELECT l.id, l.title, l.revision, l.created_at, l.updated_at,
         g.group_id,
         (SELECT COUNT(*) FROM booklist_items i WHERE i.booklist_id = l.id) AS item_count
    FROM booklists l
    LEFT JOIN group_booklists g ON g.booklist_id = l.id`;

function summaryFromRow(row: Record<string, unknown>): BooklistSummary {
  return {
    id: String(row.id),
    title: String(row.title),
    revision: Number(row.revision),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    item_count: Number(row.item_count ?? 0),
    group_id: typeof row.group_id === "string" ? row.group_id : null,
    access: EMPTY_ACCESS_FLAGS,
  };
}

export function createBooklistRow(db: Database, title: string): string {
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO booklists (id, title) VALUES (?, ?)").run(id, title);
  return id;
}

export function attachGroupBooklist(
  db: Database,
  groupId: string,
  booklistId: string,
): void {
  db.prepare(
    "INSERT INTO group_booklists (group_id, booklist_id) VALUES (?, ?)",
  ).run(groupId, booklistId);
}

export function findGroupBooklistId(
  db: Database,
  groupId: string,
): string | null {
  const row = db
    .prepare("SELECT booklist_id FROM group_booklists WHERE group_id = ?")
    .get(groupId) as { booklist_id: string } | undefined;
  return row?.booklist_id ?? null;
}

export function groupIdsForArticle(db: Database, articleId: string): string[] {
  return (
    db
      .prepare(
        `SELECT gb.group_id
           FROM group_booklists gb
           JOIN booklist_items i ON i.booklist_id = gb.booklist_id
          WHERE i.article_id = ?`,
      )
      .all(articleId) as Array<{ group_id: string }>
  ).map((row) => row.group_id);
}

export function collectionsContainingArticle(
  db: Database,
  articleId: string,
): Array<{ kind: string; id: string; revision: number }> {
  return (
    db
      .prepare(
        `SELECT l.id, l.revision
           FROM booklists l
           JOIN booklist_items i ON i.booklist_id = l.id
          WHERE i.article_id = ?`,
      )
      .all(articleId) as Array<{ id: string; revision: number }>
  ).map((row) => ({ kind: "booklist", id: row.id, revision: row.revision }));
}

export function listBooklistsByIds(
  db: Database,
  listIds: string[],
): BooklistSummary[] {
  if (listIds.length === 0) return [];
  const placeholders = listIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `${LIST_SELECT} WHERE l.id IN (${placeholders})
       ORDER BY l.updated_at DESC`,
    )
    .all(...listIds) as Array<Record<string, unknown>>;
  return rows.map(summaryFromRow);
}

export function booklistContents(db: Database, listId: string): BooklistContents {
  const row = db
    .prepare(`${LIST_SELECT} WHERE l.id = ?`)
    .get(listId) as Record<string, unknown> | undefined;
  if (!row) throw new Error("booklist not found");
  const items = db
    .prepare(
      `SELECT article_id, position, added_at
         FROM booklist_items WHERE booklist_id = ? ORDER BY position`,
    )
    .all(listId) as BooklistItemRow[];
  return { list: summaryFromRow(row), items };
}

function touchBooklist(db: Database, listId: string): void {
  db.prepare(
    `UPDATE booklists SET revision = revision + 1, updated_at = datetime('now')
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
      "SELECT 1 FROM booklist_items WHERE booklist_id = ? AND article_id = ?",
    )
    .get(listId, articleId);
  if (!existing) {
    const position = db
      .prepare(
        "SELECT COALESCE(MAX(position), -1) + 1 AS position FROM booklist_items WHERE booklist_id = ?",
      )
      .get(listId) as { position: number };
    db.prepare(
      "INSERT INTO booklist_items (booklist_id, position, article_id) VALUES (?, ?, ?)",
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
    "DELETE FROM booklist_items WHERE booklist_id = ? AND article_id = ?",
  ).run(listId, articleId);
  const rows = db
    .prepare(
      "SELECT article_id, position FROM booklist_items WHERE booklist_id = ? ORDER BY position",
    )
    .all(listId) as Array<{ article_id: string; position: number }>;
  const update = db.prepare(
    "UPDATE booklist_items SET position = ? WHERE booklist_id = ? AND article_id = ?",
  );
  rows.forEach((row, index) => {
    if (row.position !== index) update.run(index, listId, row.article_id);
  });
  touchBooklist(db, listId);
  return booklistContents(db, listId);
}

export function deleteBooklist(db: Database, listId: string): void {
  booklistContents(db, listId);
  db.prepare("DELETE FROM booklists WHERE id = ?").run(listId);
}

export function articleIdsForBooklist(db: Database, listId: string): string[] {
  return booklistContents(db, listId).items.map((item) => item.article_id);
}

export type { ArticleWithMeta };
