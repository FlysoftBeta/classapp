import type BetterSqlite3 from "better-sqlite3";

export function getUserConfigValue(
  db: BetterSqlite3.Database,
  userId: string,
  key: string,
): string | null {
  const row = db
    .prepare("SELECT value FROM user_config WHERE user_id = ? AND key = ?")
    .get(userId, key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function getUserConfigVersion(
  db: BetterSqlite3.Database,
  userId: string,
  key: string,
): { value: string | null; updatedAt: number } {
  const row = db
    .prepare(
      "SELECT value, updated_at_ms AS updatedAt FROM user_config WHERE user_id = ? AND key = ?",
    )
    .get(userId, key) as { value: string; updatedAt: number } | undefined;
  return row ?? { value: null, updatedAt: 0 };
}

export function upsertUserConfigVersion(
  db: BetterSqlite3.Database,
  userId: string,
  key: string,
  value: string,
  updatedAt: number,
): { value: string | null; updatedAt: number } {
  db.prepare(
    `INSERT INTO user_config (user_id, key, value, updated_at, updated_at_ms)
     VALUES (?, ?, ?, datetime('now'), ?)
     ON CONFLICT(user_id, key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at,
       updated_at_ms = excluded.updated_at_ms
     WHERE excluded.updated_at_ms >= user_config.updated_at_ms`,
  ).run(userId, key, value, updatedAt);
  return getUserConfigVersion(db, userId, key);
}

export function upsertUserConfigValue(
  db: BetterSqlite3.Database,
  userId: string,
  key: string,
  value: string,
): void {
  db.prepare(
    `INSERT INTO user_config (user_id, key, value, updated_at, updated_at_ms)
     VALUES (?, ?, ?, datetime('now'), ?)
     ON CONFLICT(user_id, key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at,
       updated_at_ms = excluded.updated_at_ms`,
  ).run(userId, key, value, Date.now());
}

export function deleteUserConfigValue(
  db: BetterSqlite3.Database,
  userId: string,
  key: string,
): void {
  db.prepare("DELETE FROM user_config WHERE user_id = ? AND key = ?").run(
    userId,
    key,
  );
}
