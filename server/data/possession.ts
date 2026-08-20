import type { Database } from "better-sqlite3";

export interface PossessionRow {
  userId: string;
  resourceKind: string;
  resourceId: string;
  capability: string;
  sourceKind: string;
  sourceId: string | null;
  expiresAtMs: number;
}

export function upsertPossession(db: Database, row: PossessionRow): void {
  db.prepare(
    `INSERT INTO resource_possession (
       user_id, resource_kind, resource_id, capability,
       source_kind, source_id, expires_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, resource_kind, resource_id) DO UPDATE SET
       capability = excluded.capability,
       source_kind = excluded.source_kind,
       source_id = excluded.source_id,
       expires_at_ms = excluded.expires_at_ms,
       updated_at = datetime('now')`,
  ).run(
    row.userId,
    row.resourceKind,
    row.resourceId,
    row.capability,
    row.sourceKind,
    row.sourceId,
    row.expiresAtMs,
  );
}

export function readPossession(
  db: Database,
  userId: string,
  resourceKind: string,
  resourceId: string,
): PossessionRow | null {
  const row = db
    .prepare(
      `SELECT user_id, resource_kind, resource_id, capability,
              source_kind, source_id, expires_at_ms
         FROM resource_possession
        WHERE user_id = ? AND resource_kind = ? AND resource_id = ?`,
    )
    .get(userId, resourceKind, resourceId) as
    | {
        user_id: string;
        resource_kind: string;
        resource_id: string;
        capability: string;
        source_kind: string;
        source_id: string | null;
        expires_at_ms: number;
      }
    | undefined;
  if (!row) return null;
  return {
    userId: row.user_id,
    resourceKind: row.resource_kind,
    resourceId: row.resource_id,
    capability: row.capability,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    expiresAtMs: row.expires_at_ms,
  };
}

export function deletePossession(
  db: Database,
  userId: string,
  resourceKind: string,
  resourceId: string,
): void {
  db.prepare(
    `DELETE FROM resource_possession
      WHERE user_id = ? AND resource_kind = ? AND resource_id = ?`,
  ).run(userId, resourceKind, resourceId);
}
