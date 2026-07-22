import type BetterSqlite3 from "better-sqlite3";

export function listEventGroupIds(
  db: BetterSqlite3.Database,
  userId: string,
): string[] {
  return (
    db
      .prepare("SELECT group_id FROM user_groups WHERE user_id = ?")
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
        `SELECT DISTINCT CASE WHEN user_id = ? THEN dm_to ELSE user_id END AS partner
     FROM posts WHERE (user_id = ? OR dm_to = ?) AND dm_to IS NOT NULL`,
      )
      .all(userId, userId, userId) as { partner: string | null }[]
  ).flatMap((row) => (row.partner ? [row.partner] : []));
}
