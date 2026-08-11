import type { Database } from "better-sqlite3";

export type IncidentEnvironment = "server" | "client";

export interface IncidentGroupRow {
  id: number;
  environment: IncidentEnvironment;
  build_id: string;
  fingerprint: string;
  top_frame: string;
  occurrence_count: number;
  stored_detail_count: number;
  first_at: string;
  last_at: string;
}

export interface IncidentRow {
  id: number;
  public_id: string;
  group_id: number;
  occurred_at: string;
  error_name: string | null;
  message: string | null;
  stack: string | null;
  context_json: string | null;
  related_incident_ids_json: string | null;
}

export interface IncidentLogRow extends IncidentRow {
  environment: IncidentEnvironment;
  build_id: string;
  fingerprint: string;
  top_frame: string;
  occurrence_count: number;
  stored_detail_count: number;
  first_at: string;
  last_at: string;
}

export interface InsertIncidentInput {
  environment: IncidentEnvironment;
  buildId: string;
  fingerprint: string;
  topFrame: string;
  occurredAt: string;
  errorName: string;
  message: string;
  stack: string;
  context: Record<string, unknown> | null;
  relatedIncidentIds: string[];
  publicIdFor: (id: number) => string;
}

/** Allocate every occurrence while retaining detailed payloads for only ten. */
export function insertIncident(
  db: Database,
  input: InsertIncidentInput,
): { id: number; publicId: string; groupId: number; detailStored: boolean } {
  return db.transaction(() => {
    db.prepare(
      `INSERT INTO incident_groups (
         environment, build_id, fingerprint, top_frame,
         occurrence_count, stored_detail_count, first_at, last_at
       ) VALUES (?, ?, ?, ?, 0, 0, ?, ?)
       ON CONFLICT(environment, build_id, fingerprint) DO UPDATE SET
         occurrence_count = incident_groups.occurrence_count,
         last_at = excluded.last_at`,
    ).run(
      input.environment,
      input.buildId,
      input.fingerprint,
      input.topFrame,
      input.occurredAt,
      input.occurredAt,
    );

    const group = db
      .prepare(
        `SELECT id, stored_detail_count
         FROM incident_groups
         WHERE environment = ? AND build_id = ? AND fingerprint = ?`,
      )
      .get(input.environment, input.buildId, input.fingerprint) as {
      id: number;
      stored_detail_count: number;
    };
    const detailStored = group.stored_detail_count < 10;
    const result = db
      .prepare(
        `INSERT INTO incidents (
           group_id, occurred_at, error_name, message, stack,
           context_json, related_incident_ids_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        group.id,
        input.occurredAt,
        detailStored ? input.errorName : null,
        detailStored ? input.message : null,
        detailStored ? input.stack : null,
        detailStored && input.context ? JSON.stringify(input.context) : null,
        detailStored && input.relatedIncidentIds.length
          ? JSON.stringify(input.relatedIncidentIds)
          : null,
      );
    const id = Number(result.lastInsertRowid);
    const publicId = input.publicIdFor(id);
    db.prepare("UPDATE incidents SET public_id = ? WHERE id = ?").run(
      publicId,
      id,
    );
    db.prepare(
      `UPDATE incident_groups SET
         occurrence_count = occurrence_count + 1,
         stored_detail_count = stored_detail_count + ?,
         last_at = ?
       WHERE id = ?`,
    ).run(detailStored ? 1 : 0, input.occurredAt, group.id);
    return { id, publicId, groupId: group.id, detailStored };
  })();
}

export function listIncidentGroups(
  db: Database,
  input: {
    environment?: IncidentEnvironment;
    buildId?: string;
    offset: number;
    limit: number;
  },
): IncidentGroupRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (input.environment) {
    clauses.push("environment = ?");
    params.push(input.environment);
  }
  if (input.buildId) {
    clauses.push("build_id = ?");
    params.push(input.buildId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db
    .prepare(
      `SELECT * FROM incident_groups ${where}
       ORDER BY last_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, input.limit, input.offset) as IncidentGroupRow[];
}

export function listIncidentsForGroup(
  db: Database,
  groupId: number,
): IncidentRow[] {
  return db
    .prepare(
      `SELECT * FROM incidents WHERE group_id = ? ORDER BY id DESC LIMIT 100`,
    )
    .all(groupId) as IncidentRow[];
}

export function findIncidentByPublicId(
  db: Database,
  publicId: string,
): IncidentRow | null {
  return (
    (db.prepare("SELECT * FROM incidents WHERE public_id = ?").get(publicId) as
      IncidentRow | undefined) ?? null
  );
}

/** Read every retained occurrence for one build; archive shaping stays in services. */
export function listIncidentLogsForBuild(
  db: Database,
  buildId: string,
): IncidentLogRow[] {
  return db
    .prepare(
      `SELECT
         i.id, i.public_id, i.group_id, i.occurred_at, i.error_name,
         i.message, i.stack, i.context_json, i.related_incident_ids_json,
         g.environment, g.build_id, g.fingerprint, g.top_frame,
         g.occurrence_count, g.stored_detail_count, g.first_at, g.last_at
       FROM incidents i
       JOIN incident_groups g ON g.id = i.group_id
       WHERE g.build_id = ?
       ORDER BY i.id ASC`,
    )
    .all(buildId) as IncidentLogRow[];
}
