import type BetterSqlite3 from "better-sqlite3";

export function deleteExpiredSessions(db: BetterSqlite3.Database): number {
  const info = db
    .prepare(
      "DELETE FROM sessions WHERE created_at < datetime('now', '-1 day')",
    )
    .run();
  return info.changes;
}

export function listInactiveClientIds(
  db: BetterSqlite3.Database,
  ttlDays: number,
): string[] {
  const rows = db
    .prepare(
      `SELECT c.id FROM clients c
       WHERE c.persistent = 0
         AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.client_id = c.id)
         AND COALESCE(
           (SELECT MAX(ci.last_seen) FROM client_ips ci WHERE ci.client_id = c.id),
           c.created_at
         ) < datetime('now', ? || ' days')
         AND COALESCE(
           (SELECT cla.last_at FROM client_last_active cla WHERE cla.client_id = c.id),
           c.created_at
         ) < datetime('now', ? || ' days')`,
    )
    .all(`-${ttlDays}`, `-${ttlDays}`) as { id: string }[];
  return rows.map((row) => row.id);
}

export function listIdleLockedClientIds(
  db: BetterSqlite3.Database,
  idleTimeoutMinutes: number,
): string[] {
  const rows = db
    .prepare(
      `SELECT cla.client_id AS id
       FROM client_last_active cla
       JOIN sessions s ON s.client_id = cla.client_id
       WHERE CAST((julianday('now') - julianday(cla.last_at)) * 24 * 60 AS REAL) > ?`,
    )
    .all(idleTimeoutMinutes) as { id: string }[];
  return rows.map((row) => row.id);
}
