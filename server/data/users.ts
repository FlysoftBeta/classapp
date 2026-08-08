import crypto from "crypto";
import type BetterSqlite3 from "better-sqlite3";
import { parseDbTime } from "@/shared/time";
import type { Group, User } from "@/shared/types/api";

export const USER_SELECT = `SELECT u.id, u.handle, u.username, u.feature_mask,
   CASE WHEN u.is_muted = 1 AND (u.muted_until IS NULL OR u.muted_until > datetime('now')) THEN 1 ELSE 0 END AS is_muted,
   u.muted_until, u.banned_until, u.created_at
   FROM users u LEFT JOIN deleted_users du ON du.id = u.id
   WHERE u.id = ? AND du.id IS NULL`;

export interface NewUserData {
  id: string;
  handle: string;
  username: string;
  featureMask: number;
  pinHashes: string[];
}

export interface BanStatus {
  banned: boolean;
  banned_until: string | null;
}

export interface MuteStatus {
  muted: boolean;
  muted_until: string | null;
}

export function insertNewUser(
  db: BetterSqlite3.Database,
  data: NewUserData,
): void {
  db.prepare(
    "INSERT INTO users (id, handle, username, role, feature_mask) VALUES (?, ?, ?, ?, ?)",
  ).run(
    data.id,
    data.handle,
    data.username,
    data.featureMask & 1 ? "admin" : "user",
    data.featureMask,
  );
  for (const pinHash of data.pinHashes) {
    db.prepare(
      "INSERT INTO user_pins (id, user_id, pin_hash) VALUES (?, ?, ?)",
    ).run(crypto.randomUUID(), data.id, pinHash);
  }
  db.prepare(
    `INSERT OR IGNORE INTO group_members (user_id, group_id)
     SELECT ?, id FROM groups WHERE type IN ('wild', 'announcement')`,
  ).run(data.id);
}

export function getUser(db: BetterSqlite3.Database, id: string): User | null {
  return (db.prepare(USER_SELECT).get(id) as User | undefined) ?? null;
}

export function searchUsers(
  db: BetterSqlite3.Database,
  q = "",
  offset = 0,
): User[] {
  return q
    ? (db
        .prepare(
          `SELECT u.id, u.handle, u.username, u.feature_mask,
           CASE WHEN u.is_muted = 1 AND (u.muted_until IS NULL OR u.muted_until > datetime('now')) THEN 1 ELSE 0 END AS is_muted,
           u.muted_until, u.banned_until, u.created_at FROM users u
           LEFT JOIN deleted_users du ON du.id = u.id
           WHERE du.id IS NULL AND (handle LIKE ? OR u.username LIKE ?)
           ORDER BY created_at DESC LIMIT 50 OFFSET ?`,
        )
        .all(`%${q}%`, `%${q}%`, offset) as User[])
    : (db
        .prepare(
          `SELECT u.id, u.handle, u.username, u.feature_mask,
           CASE WHEN u.is_muted = 1 AND (u.muted_until IS NULL OR u.muted_until > datetime('now')) THEN 1 ELSE 0 END AS is_muted,
           u.muted_until, u.banned_until, u.created_at FROM users u
           LEFT JOIN deleted_users du ON du.id = u.id
           WHERE du.id IS NULL
           ORDER BY created_at DESC LIMIT 50 OFFSET ?`,
        )
        .all(offset) as User[]);
}

export function countUsers(db: BetterSqlite3.Database, q = ""): number {
  return q
    ? (
        db
          .prepare(
            `SELECT COUNT(*) as n FROM users u
             LEFT JOIN deleted_users du ON du.id = u.id
             WHERE du.id IS NULL AND (u.handle LIKE ? OR u.username LIKE ?)`,
          )
          .get(`%${q}%`, `%${q}%`) as { n: number }
      ).n
    : (
        db
          .prepare(
            `SELECT COUNT(*) as n FROM users u
             LEFT JOIN deleted_users du ON du.id = u.id WHERE du.id IS NULL`,
          )
          .get() as { n: number }
      ).n;
}

export function userExists(db: BetterSqlite3.Database, id: string): boolean {
  return !!db
    .prepare(
      `SELECT u.id FROM users u
       LEFT JOIN deleted_users du ON du.id = u.id
       WHERE u.id = ? AND du.id IS NULL`,
    )
    .get(id);
}

export function findUserIdByHandle(
  db: BetterSqlite3.Database,
  handle: string,
): string | null {
  const row = db
    .prepare(
      `SELECT u.id FROM users u
       LEFT JOIN deleted_users du ON du.id = u.id
       WHERE u.handle = ? AND du.id IS NULL`,
    )
    .get(handle) as { id: string } | undefined;
  return row?.id ?? null;
}

export function findUserIdByHandleExcept(
  db: BetterSqlite3.Database,
  handle: string,
  excludedUserId: string,
): string | null {
  const row = db
    .prepare(
      `SELECT u.id FROM users u
       LEFT JOIN deleted_users du ON du.id = u.id
       WHERE u.handle = ? AND u.id != ? AND du.id IS NULL`,
    )
    .get(handle, excludedUserId) as { id: string } | undefined;
  return row?.id ?? null;
}

export function findUserPinOwnerId(
  db: BetterSqlite3.Database,
  pinHash: string,
): string | null {
  const row = db
    .prepare("SELECT user_id FROM user_pins WHERE pin_hash = ?")
    .get(pinHash) as { user_id: string } | undefined;
  return row?.user_id ?? null;
}

export function findUserPinOwnerIdExcept(
  db: BetterSqlite3.Database,
  pinHash: string,
  excludedUserId: string,
): string | null {
  const row = db
    .prepare(
      "SELECT user_id FROM user_pins WHERE pin_hash = ? AND user_id != ?",
    )
    .get(pinHash, excludedUserId) as { user_id: string } | undefined;
  return row?.user_id ?? null;
}

export function replaceUserPins(
  db: BetterSqlite3.Database,
  userId: string,
  pinHashes: string[],
): void {
  db.prepare("DELETE FROM user_pins WHERE user_id = ?").run(userId);
  for (const pinHash of pinHashes) {
    db.prepare(
      "INSERT INTO user_pins (id, user_id, pin_hash) VALUES (?, ?, ?)",
    ).run(crypto.randomUUID(), userId, pinHash);
  }
}

export function userHasPinHash(
  db: BetterSqlite3.Database,
  userId: string,
  pinHash: string,
): boolean {
  return !!db
    .prepare("SELECT id FROM user_pins WHERE user_id = ? AND pin_hash = ?")
    .get(userId, pinHash);
}

export function updateUserHandle(
  db: BetterSqlite3.Database,
  userId: string,
  handle: string,
): void {
  db.prepare("UPDATE users SET handle = ? WHERE id = ?").run(handle, userId);
}

export function updateUserUsername(
  db: BetterSqlite3.Database,
  userId: string,
  username: string,
): void {
  db.prepare("UPDATE users SET username = ? WHERE id = ?").run(
    username,
    userId,
  );
}

export function updateUserRole(
  db: BetterSqlite3.Database,
  userId: string,
  role: "admin" | "user",
): void {
  db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, userId);
}

export function updateUserFeatureMask(
  db: BetterSqlite3.Database,
  userId: string,
  featureMask: number,
): void {
  db.prepare("UPDATE users SET feature_mask = ? WHERE id = ?").run(
    featureMask,
    userId,
  );
}

export function updateUserMuted(
  db: BetterSqlite3.Database,
  userId: string,
  mutedUntil: string | null,
): void {
  db.prepare("UPDATE users SET is_muted = ?, muted_until = ? WHERE id = ?").run(
    mutedUntil ? 1 : 0,
    mutedUntil,
    userId,
  );
}

export function deleteUserById(
  db: BetterSqlite3.Database,
  userId: string,
): void {
  db.prepare("DELETE FROM users WHERE id = ?").run(userId);
}

export function updateUserBanUntil(
  db: BetterSqlite3.Database,
  userId: string,
  bannedUntil: string | null,
): void {
  db.prepare("UPDATE users SET banned_until = ? WHERE id = ?").run(
    bannedUntil,
    userId,
  );
}

export function deleteUserSessions(
  db: BetterSqlite3.Database,
  userId: string,
): void {
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

export function revokeUserCredentials(
  db: BetterSqlite3.Database,
  userId: string,
): void {
  db.prepare("DELETE FROM user_pins WHERE user_id = ?").run(userId);
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  db.prepare(
    `UPDATE users SET handle = ?, role = 'user', feature_mask = 0,
       is_muted = 0, muted_until = NULL, banned_until = NULL
     WHERE id = ?`,
  ).run(`deleted_${userId.replace(/-/g, "")}`, userId);
}

export function getUserProfile(
  db: BetterSqlite3.Database,
  id: string,
): { user: User; pinCount: number; groups: Group[] } {
  const user = db.prepare(USER_SELECT).get(id) as User;
  if (!user) throw new Error("干员不存在");
  const pinCount = (
    db
      .prepare("SELECT COUNT(*) as n FROM user_pins WHERE user_id = ?")
      .get(id) as { n: number }
  ).n;
  const groups = db
    .prepare(
      `SELECT g.id, g.handle, g.name, (g.password_hash IS NOT NULL) as has_password,
       g.conv_id, g.revision, g.type, g.members_hidden, g.admin_only, g.no_leave, g.parent_group_id, g.created_at
       FROM group_members ug
       JOIN groups g ON ug.group_id = g.id
       WHERE ug.user_id = ?`,
    )
    .all(id) as Group[];
  return { user, pinCount, groups };
}

export function getUserBanStatus(
  db: BetterSqlite3.Database,
  userId: string,
): BanStatus {
  const row = db
    .prepare("SELECT banned_until FROM users WHERE id = ?")
    .get(userId) as { banned_until: string | null } | undefined;
  if (!row) return { banned: false, banned_until: null };

  if (!row.banned_until) return { banned: false, banned_until: null };

  const until = parseDbTime(row.banned_until);
  if (new Date() >= until) {
    db.prepare("UPDATE users SET banned_until = NULL WHERE id = ?").run(userId);
    return { banned: false, banned_until: null };
  }
  return { banned: true, banned_until: row.banned_until };
}

export function getUserMuteStatus(
  db: BetterSqlite3.Database,
  userId: string,
): MuteStatus {
  const row = db
    .prepare("SELECT is_muted, muted_until FROM users WHERE id = ?")
    .get(userId) as
    { is_muted: number; muted_until: string | null } | undefined;
  if (!row || !row.is_muted) return { muted: false, muted_until: null };
  if (!row.muted_until) return { muted: true, muted_until: null };
  if (parseDbTime(row.muted_until) <= new Date()) {
    updateUserMuted(db, userId, null);
    return { muted: false, muted_until: null };
  }
  return { muted: true, muted_until: row.muted_until };
}
