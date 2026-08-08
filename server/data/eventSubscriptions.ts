import type BetterSqlite3 from "better-sqlite3";

export function listEventGroupIds(
  db: BetterSqlite3.Database,
  userId: string,
): string[] {
  return (
    db
      .prepare("SELECT group_id FROM group_members WHERE user_id = ?")
      .all(userId) as { group_id: string }[]
  ).map((row) => row.group_id);
}

export function listEventDmPartnerIds(
  db: BetterSqlite3.Database,
  userId: string,
): string[] {
  return (
    db
      .prepare(
        `SELECT CASE WHEN peer_a = ? THEN peer_b ELSE peer_a END AS partner
         FROM dms WHERE peer_a = ? OR peer_b = ?`,
      )
      .all(userId, userId, userId) as { partner: string | null }[]
  ).flatMap((row) => (row.partner ? [row.partner] : []));
}
