import type { Database } from "better-sqlite3";

export interface DeletedUser {
  id: string;
  username: string;
  deleted_at: string;
}

export function insertDeletedUser(
  db: Database,
  user: { id: string; username: string },
): void {
  db.prepare(
    "UPDATE users SET profile_revision = profile_revision + 1 WHERE id = ?",
  ).run(user.id);
  db.prepare(
    `INSERT INTO deleted_users (id, username)
     VALUES (?, ?)
     ON CONFLICT(id) DO UPDATE SET
       username = excluded.username,
       deleted_at = datetime('now')`,
  ).run(user.id, user.username);
}

export function getDeletedUser(
  db: Database,
  userId: string,
): DeletedUser | null {
  return (
    (db
      .prepare(
        "SELECT id, username, deleted_at FROM deleted_users WHERE id = ?",
      )
      .get(userId) as DeletedUser | undefined) ?? null
  );
}

export function isDeletedUser(db: Database, userId: string): boolean {
  return !!db.prepare("SELECT 1 FROM deleted_users WHERE id = ?").get(userId);
}
