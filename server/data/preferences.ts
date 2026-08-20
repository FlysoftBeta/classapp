import type { Database } from "better-sqlite3";

/** Preference overlay. These rows are not access bindings or capabilities. */

export function upsertFavorite(
  db: Database,
  userId: string,
  resourceKind: string,
  resourceId: string,
  favorited: boolean,
  updatedAtMs: number,
): { value: boolean; updatedAt: number } {
  const existing = db
    .prepare(
      `SELECT updated_at_ms FROM user_favorites
        WHERE user_id = ? AND resource_kind = ? AND resource_id = ?`,
    )
    .get(userId, resourceKind, resourceId) as
    | { updated_at_ms: number }
    | undefined;
  if (existing && existing.updated_at_ms > updatedAtMs) {
    const current = db
      .prepare(
        `SELECT favorited FROM user_favorites
          WHERE user_id = ? AND resource_kind = ? AND resource_id = ?`,
      )
      .get(userId, resourceKind, resourceId) as { favorited: number };
    return { value: current.favorited === 1, updatedAt: existing.updated_at_ms };
  }
  db.prepare(
    `INSERT INTO user_favorites (
       user_id, resource_kind, resource_id, favorited, updated_at_ms, created_at
     ) VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, resource_kind, resource_id) DO UPDATE SET
       favorited = excluded.favorited,
       updated_at_ms = excluded.updated_at_ms,
       created_at = CASE WHEN excluded.favorited = 1 THEN datetime('now')
                         ELSE user_favorites.created_at END`,
  ).run(userId, resourceKind, resourceId, favorited ? 1 : 0, updatedAtMs);
  return { value: favorited, updatedAt: updatedAtMs };
}

export function listFavoriteIds(
  db: Database,
  userId: string,
  resourceKind: string,
): string[] {
  return (
    db
      .prepare(
        `SELECT resource_id FROM user_favorites
          WHERE user_id = ? AND resource_kind = ? AND favorited = 1
          ORDER BY updated_at_ms DESC, resource_id DESC`,
      )
      .all(userId, resourceKind) as Array<{ resource_id: string }>
  ).map((row) => row.resource_id);
}

export function isFavorited(
  db: Database,
  userId: string,
  resourceKind: string,
  resourceId: string,
): boolean {
  const row = db
    .prepare(
      `SELECT favorited FROM user_favorites
        WHERE user_id = ? AND resource_kind = ? AND resource_id = ?`,
    )
    .get(userId, resourceKind, resourceId) as { favorited: number } | undefined;
  return row?.favorited === 1;
}

export function touchRecent(
  db: Database,
  userId: string,
  resourceKind: string,
  resourceId: string,
  now = Date.now(),
): void {
  db.prepare(
    `INSERT INTO user_recents (
       user_id, resource_kind, resource_id, last_used_at, last_used_at_ms
     ) VALUES (?, ?, ?, datetime('now'), ?)
     ON CONFLICT(user_id, resource_kind, resource_id) DO UPDATE SET
       last_used_at = datetime('now'),
       last_used_at_ms = excluded.last_used_at_ms`,
  ).run(userId, resourceKind, resourceId, now);
}

export function listRecentIds(
  db: Database,
  userId: string,
  resourceKind: string,
  limit = 50,
): string[] {
  return (
    db
      .prepare(
        `SELECT resource_id FROM user_recents
          WHERE user_id = ? AND resource_kind = ?
          ORDER BY last_used_at_ms DESC, resource_id DESC
          LIMIT ?`,
      )
      .all(userId, resourceKind, limit) as Array<{ resource_id: string }>
  ).map((row) => row.resource_id);
}
