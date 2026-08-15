import crypto from "node:crypto";
import type { Database } from "better-sqlite3";

export interface AuditEntry {
  id: string;
  actor_id: string | null;
  action: string;
  target_kind: string;
  target_id: string | null;
  details: Record<string, unknown>;
  created_at: string;
}

interface AuditRow extends Omit<AuditEntry, "details"> {
  details_json: string;
}

export function insertAuditEntry(
  db: Database,
  input: {
    actorId: string | null;
    action: string;
    targetKind: string;
    targetId?: string | null;
    details?: Record<string, unknown>;
  },
): void {
  db.prepare(
    `INSERT INTO admin_audit_log
      (id, actor_id, action, target_kind, target_id, details_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    input.actorId,
    input.action,
    input.targetKind,
    input.targetId ?? null,
    JSON.stringify(input.details ?? {}),
  );
}

export function listAuditEntries(
  db: Database,
  offset: number,
  limit: number,
): AuditEntry[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.actor_id, a.action,
      a.target_kind, a.target_id, a.details_json, a.created_at
     FROM admin_audit_log a
     ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as AuditRow[];
  return rows.map(({ details_json, ...row }) => ({
    ...row,
    details: JSON.parse(details_json) as Record<string, unknown>,
  }));
}
