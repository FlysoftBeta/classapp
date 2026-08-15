import type BetterSqlite3 from "better-sqlite3";
import type { User } from "@/shared/types/api";
import { hydrateUser, type UserRow } from "@/server/data/users";

export function findUserByPinHash(
  db: BetterSqlite3.Database,
  pinHash: string,
): User | null {
  const row = db
    .prepare(
      `SELECT u.id, u.profile_revision, u.handle, u.username, u.feature_bitset,
         CASE WHEN u.is_muted = 1 AND (u.muted_until IS NULL OR u.muted_until > datetime('now')) THEN 1 ELSE 0 END AS is_muted,
         u.muted_until, u.banned_until, u.created_at
         FROM user_pins up
         JOIN users u ON up.user_id = u.id
         WHERE up.pin_hash = ?`,
    )
    .get(pinHash) as UserRow | undefined;
  return row ? hydrateUser(db, row) : null;
}

export function replaceClientUserSession(
  db: BetterSqlite3.Database,
  input: { clientId: string; userId: string; token: string },
): void {
  db.prepare("DELETE FROM sessions WHERE client_id = ? AND user_id = ?").run(
    input.clientId,
    input.userId,
  );
  db.prepare(
    "INSERT INTO sessions (token, user_id, client_id) VALUES (?, ?, ?)",
  ).run(input.token, input.userId, input.clientId);
}

export function insertSession(
  db: BetterSqlite3.Database,
  input: { token: string; userId: string; clientId: string },
): void {
  db.prepare(
    "INSERT INTO sessions (token, user_id, client_id) VALUES (?, ?, ?)",
  ).run(input.token, input.userId, input.clientId);
}

export function getLatestClientStateByIp(
  db: BetterSqlite3.Database,
  ip: string,
): { clientId: string; konamiLocked: boolean } | null {
  const row = db
    .prepare(
      `SELECT ci.client_id, c.konami_locked
       FROM client_ips ci
       JOIN clients c ON c.id = ci.client_id
       WHERE ci.ip = ?
       ORDER BY ci.last_seen DESC
       LIMIT 1`,
    )
    .get(ip) as { client_id: string; konami_locked: number } | undefined;
  if (!row) {
    return null;
  }
  return {
    clientId: row.client_id,
    konamiLocked: row.konami_locked === 1,
  };
}

export function findRecentSessionByClientId(
  db: BetterSqlite3.Database,
  clientId: string,
): { user: User; token: string } | null {
  const row = db
    .prepare(
      `SELECT u.id, u.profile_revision, u.handle, u.username, u.feature_bitset,
       CASE WHEN u.is_muted = 1 AND (u.muted_until IS NULL OR u.muted_until > datetime('now')) THEN 1 ELSE 0 END AS is_muted,
       u.muted_until, u.banned_until, u.created_at, s.token
       FROM sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.client_id = ? AND s.created_at > datetime('now', '-1 day')
       ORDER BY s.created_at DESC LIMIT 1`,
    )
    .get(clientId) as (UserRow & { token: string }) | undefined;
  if (!row) {
    return null;
  }
  const { token, ...user } = row;
  return { user: hydrateUser(db, user), token };
}

export function deleteSessionByToken(
  db: BetterSqlite3.Database,
  token: string,
): void {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

export function deleteExpiredSessions(db: BetterSqlite3.Database): void {
  db.prepare(
    "DELETE FROM sessions WHERE created_at < datetime('now', '-1 day')",
  ).run();
}

export function findUserBySessionToken(
  db: BetterSqlite3.Database,
  token: string,
): User | null {
  const row = db
    .prepare(
      `SELECT u.id, u.profile_revision, u.handle, u.username, u.feature_bitset,
         CASE WHEN u.is_muted = 1 AND (u.muted_until IS NULL OR u.muted_until > datetime('now')) THEN 1 ELSE 0 END AS is_muted,
         u.muted_until, u.banned_until, u.created_at
     FROM sessions s JOIN users u ON s.user_id = u.id
     WHERE s.token = ? AND s.created_at > datetime('now', '-1 day')`,
    )
    .get(token) as UserRow | undefined;
  return row ? hydrateUser(db, row) : null;
}

export function findSessionIdentityByToken(
  db: BetterSqlite3.Database,
  token: string,
): { userId: string; clientId: string } | null {
  const row = db
    .prepare(
      `SELECT user_id, client_id FROM sessions
       WHERE token = ? AND created_at > datetime('now', '-1 day')`,
    )
    .get(token) as { user_id: string; client_id: string } | undefined;
  return row ? { userId: row.user_id, clientId: row.client_id } : null;
}
