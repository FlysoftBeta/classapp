import crypto from "crypto";
import type BetterSqlite3 from "better-sqlite3";

export interface GhostUserRecord {
  id: string;
  created_at: string;
  pending_oobe: number;
}

export function ghostPinHashExists(
  db: BetterSqlite3.Database,
  pinHash: string,
): boolean {
  return !!db
    .prepare("SELECT id FROM ghost_users WHERE pin_hash = ?")
    .get(pinHash);
}

export function findGhostUserIdByPinHash(
  db: BetterSqlite3.Database,
  pinHash: string,
): string | null {
  const row = db
    .prepare("SELECT id FROM ghost_users WHERE pin_hash = ?")
    .get(pinHash) as { id: string } | undefined;
  return row?.id ?? null;
}

export function insertGhostUser(
  db: BetterSqlite3.Database,
  input: { id: string; pinHash: string },
): void {
  db.prepare("INSERT INTO ghost_users (id, pin_hash) VALUES (?, ?)").run(
    input.id,
    input.pinHash,
  );
}

export function createGhostUserRecord(
  db: BetterSqlite3.Database,
  pinHash: string,
): string {
  const id = crypto.randomUUID();
  insertGhostUser(db, { id, pinHash });
  return id;
}

export function listGhostUsers(db: BetterSqlite3.Database): GhostUserRecord[] {
  return db
    .prepare(
      "SELECT id, created_at, (oobe_token IS NOT NULL) as pending_oobe FROM ghost_users ORDER BY created_at DESC",
    )
    .all() as GhostUserRecord[];
}

export function deleteGhostUserById(
  db: BetterSqlite3.Database,
  id: string,
): boolean {
  const info = db.prepare("DELETE FROM ghost_users WHERE id = ?").run(id);
  return info.changes > 0;
}

export function issueGhostOobeToken(
  db: BetterSqlite3.Database,
  ghostId: string,
): string {
  const token = crypto.randomBytes(20).toString("hex");
  const expires = new Date(Date.now() + 30 * 60 * 1000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
  db.prepare(
    "UPDATE ghost_users SET oobe_token = ?, oobe_expires = ? WHERE id = ?",
  ).run(token, expires, ghostId);
  return token;
}

export function findGhostUserIdByOobeToken(
  db: BetterSqlite3.Database,
  token: string,
): string | null {
  const row = db
    .prepare(
      `SELECT id FROM ghost_users
       WHERE oobe_token = ? AND oobe_expires > datetime('now')`,
    )
    .get(token) as { id: string } | undefined;
  return row?.id ?? null;
}
