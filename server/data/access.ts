import type { Database } from "better-sqlite3";
import { z } from "zod";
import {
  accessGrantSchema,
  flagsOfGrantSet,
  normalizeGrantSet,
  type AccessFlags,
  type AccessGrant,
  type OwnedResourceKind,
  type PrincipalRef,
} from "@/shared/access";

const grantsJsonSchema = z.array(accessGrantSchema).min(1);

export interface AccessBindingRow {
  resourceKind: OwnedResourceKind;
  resourceId: string;
  principal: PrincipalRef;
  grants: AccessGrant[];
  flags: AccessFlags;
}

export interface EffectiveAccessRow {
  userId: string;
  resourceKind: OwnedResourceKind;
  resourceId: string;
  flags: AccessFlags;
  provenance: readonly AccessBindingRow[];
}

export interface ProvenanceEntry {
  principal: PrincipalRef;
  grants: AccessGrant[];
}

function parseGrants(raw: string): AccessGrant[] {
  const parsed = grantsJsonSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error("access_bindings.grants_json is not a valid grant set");
  }
  return normalizeGrantSet(parsed.data);
}

function flagsFromIntegers(row: {
  can_read: number;
  can_write: number;
  can_own: number;
  can_share_read: number;
  can_share_write: number;
  can_share_own: number;
}): AccessFlags {
  return {
    read: row.can_read === 1,
    write: row.can_write === 1,
    own: row.can_own === 1,
    shareRead: row.can_share_read === 1,
    shareWrite: row.can_share_write === 1,
    shareOwn: row.can_share_own === 1,
  };
}

export function upsertAccessBinding(
  db: Database,
  resourceKind: OwnedResourceKind,
  resourceId: string,
  principal: PrincipalRef,
  grants: AccessGrant[],
): AccessBindingRow {
  const normalized = normalizeGrantSet(grants);
  db.prepare(
    `INSERT INTO access_bindings (
       resource_kind, resource_id, principal_kind, principal_id, grants_json
     ) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(resource_kind, resource_id, principal_kind, principal_id)
     DO UPDATE SET grants_json = excluded.grants_json, updated_at = datetime('now')`,
  ).run(
    resourceKind,
    resourceId,
    principal.kind,
    principal.id,
    JSON.stringify(normalized),
  );
  return {
    resourceKind,
    resourceId,
    principal,
    grants: normalized,
    flags: flagsOfGrantSet(normalized),
  };
}

export function deleteAccessBinding(
  db: Database,
  resourceKind: OwnedResourceKind,
  resourceId: string,
  principal: PrincipalRef,
): boolean {
  const result = db
    .prepare(
      `DELETE FROM access_bindings
        WHERE resource_kind = ? AND resource_id = ? AND principal_kind = ? AND principal_id = ?`,
    )
    .run(resourceKind, resourceId, principal.kind, principal.id);
  return result.changes > 0;
}

export function listBindingsForResource(
  db: Database,
  resourceKind: OwnedResourceKind,
  resourceId: string,
): AccessBindingRow[] {
  const rows = db
    .prepare(
      `SELECT resource_kind, resource_id, principal_kind, principal_id, grants_json
         FROM access_bindings
        WHERE resource_kind = ? AND resource_id = ?`,
    )
    .all(resourceKind, resourceId) as Array<{
    resource_kind: OwnedResourceKind;
    resource_id: string;
    principal_kind: PrincipalRef["kind"];
    principal_id: string;
    grants_json: string;
  }>;
  return rows.map((row) => {
    const grants = parseGrants(row.grants_json);
    return {
      resourceKind: row.resource_kind,
      resourceId: row.resource_id,
      principal: { kind: row.principal_kind, id: row.principal_id },
      grants,
      flags: flagsOfGrantSet(grants),
    };
  });
}

export function listBindingsForPrincipal(
  db: Database,
  principal: PrincipalRef,
  resourceKind?: OwnedResourceKind,
): AccessBindingRow[] {
  const rows = resourceKind
    ? (db
        .prepare(
          `SELECT resource_kind, resource_id, principal_kind, principal_id, grants_json
             FROM access_bindings
            WHERE principal_kind = ? AND principal_id = ? AND resource_kind = ?`,
        )
        .all(principal.kind, principal.id, resourceKind) as Array<{
        resource_kind: OwnedResourceKind;
        resource_id: string;
        principal_kind: PrincipalRef["kind"];
        principal_id: string;
        grants_json: string;
      }>)
    : (db
        .prepare(
          `SELECT resource_kind, resource_id, principal_kind, principal_id, grants_json
             FROM access_bindings
            WHERE principal_kind = ? AND principal_id = ?`,
        )
        .all(principal.kind, principal.id) as Array<{
        resource_kind: OwnedResourceKind;
        resource_id: string;
        principal_kind: PrincipalRef["kind"];
        principal_id: string;
        grants_json: string;
      }>);
  return rows.map((row) => {
    const grants = parseGrants(row.grants_json);
    return {
      resourceKind: row.resource_kind,
      resourceId: row.resource_id,
      principal: { kind: row.principal_kind, id: row.principal_id },
      grants,
      flags: flagsOfGrantSet(grants),
    };
  });
}

export function deleteBindingsForPrincipal(
  db: Database,
  principal: PrincipalRef,
): number {
  return db
    .prepare(
      `DELETE FROM access_bindings WHERE principal_kind = ? AND principal_id = ?`,
    )
    .run(principal.kind, principal.id).changes;
}

export function deleteBindingsForResource(
  db: Database,
  resourceKind: OwnedResourceKind,
  resourceId: string,
): void {
  db.prepare(
    `DELETE FROM access_bindings WHERE resource_kind = ? AND resource_id = ?`,
  ).run(resourceKind, resourceId);
  db.prepare(
    `DELETE FROM access_effective WHERE resource_kind = ? AND resource_id = ?`,
  ).run(resourceKind, resourceId);
}

export function readEffectiveAccess(
  db: Database,
  userId: string,
  resourceKind: OwnedResourceKind,
  resourceId: string,
): EffectiveAccessRow | null {
  const row = db
    .prepare(
      `SELECT user_id, resource_kind, resource_id,
              can_read, can_write, can_own,
              can_share_read, can_share_write, can_share_own,
              provenance_json
         FROM access_effective
        WHERE user_id = ? AND resource_kind = ? AND resource_id = ?`,
    )
    .get(userId, resourceKind, resourceId) as
    | {
        user_id: string;
        resource_kind: OwnedResourceKind;
        resource_id: string;
        can_read: number;
        can_write: number;
        can_own: number;
        can_share_read: number;
        can_share_write: number;
        can_share_own: number;
        provenance_json: string;
      }
    | undefined;
  if (!row) return null;
  const provenance = z
    .array(
      z
        .object({
          principal: z
            .object({
              kind: z.enum(["user", "group"]),
              id: z.string(),
            })
            .strict(),
          grants: z.array(accessGrantSchema).min(1),
        })
        .strict(),
    )
    .parse(JSON.parse(row.provenance_json));
  return {
    userId: row.user_id,
    resourceKind: row.resource_kind,
    resourceId: row.resource_id,
    flags: flagsFromIntegers(row),
    provenance: provenance.map((entry) => ({
      resourceKind,
      resourceId,
      principal: entry.principal,
      grants: entry.grants,
      flags: flagsOfGrantSet(entry.grants),
    })),
  };
}

export function upsertEffectiveAccess(
  db: Database,
  row: {
    userId: string;
    resourceKind: OwnedResourceKind;
    resourceId: string;
    flags: AccessFlags;
    provenance: readonly ProvenanceEntry[];
  },
): void {
  db.prepare(
    `INSERT INTO access_effective (
       user_id, resource_kind, resource_id,
       can_read, can_write, can_own,
       can_share_read, can_share_write, can_share_own,
       provenance_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, resource_kind, resource_id) DO UPDATE SET
       can_read = excluded.can_read,
       can_write = excluded.can_write,
       can_own = excluded.can_own,
       can_share_read = excluded.can_share_read,
       can_share_write = excluded.can_share_write,
       can_share_own = excluded.can_share_own,
       provenance_json = excluded.provenance_json,
       updated_at = datetime('now')`,
  ).run(
    row.userId,
    row.resourceKind,
    row.resourceId,
    row.flags.read ? 1 : 0,
    row.flags.write ? 1 : 0,
    row.flags.own ? 1 : 0,
    row.flags.shareRead ? 1 : 0,
    row.flags.shareWrite ? 1 : 0,
    row.flags.shareOwn ? 1 : 0,
    JSON.stringify(row.provenance),
  );
}

export function deleteEffectiveAccess(
  db: Database,
  userId: string,
  resourceKind: OwnedResourceKind,
  resourceId: string,
): void {
  db.prepare(
    `DELETE FROM access_effective
      WHERE user_id = ? AND resource_kind = ? AND resource_id = ?`,
  ).run(userId, resourceKind, resourceId);
}

export function listReadableResourceIds(
  db: Database,
  userId: string,
  resourceKind: OwnedResourceKind,
): string[] {
  return (
    db
      .prepare(
        `SELECT resource_id FROM access_effective
          WHERE user_id = ? AND resource_kind = ? AND can_read = 1`,
      )
      .all(userId, resourceKind) as Array<{ resource_id: string }>
  ).map((row) => row.resource_id);
}

export function listUsersWithEffectiveAccess(
  db: Database,
  resourceKind: OwnedResourceKind,
  resourceId: string,
): string[] {
  return (
    db
      .prepare(
        `SELECT user_id FROM access_effective
          WHERE resource_kind = ? AND resource_id = ? AND can_read = 1`,
      )
      .all(resourceKind, resourceId) as Array<{ user_id: string }>
  ).map((row) => row.user_id);
}

export interface PossessionRow {
  userId: string;
  resourceKind: "track" | "article";
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
  resourceKind: "track" | "article",
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
        resource_kind: "track" | "article";
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
  resourceKind: "track" | "article",
  resourceId: string,
): void {
  db.prepare(
    `DELETE FROM resource_possession
      WHERE user_id = ? AND resource_kind = ? AND resource_id = ?`,
  ).run(userId, resourceKind, resourceId);
}

export function upsertFavorite(
  db: Database,
  userId: string,
  resourceKind: "track" | "article" | "playlist" | "booklist",
  resourceId: string,
  favorited: boolean,
  updatedAtMs: number,
): { value: boolean; updatedAt: number } {
  const existing = db
    .prepare(
      `SELECT updated_at_ms FROM user_favorites
        WHERE user_id = ? AND resource_kind = ? AND resource_id = ?`,
    )
    .get(userId, resourceKind, resourceId) as
    | { updated_at_ms: number }
    | undefined;
  if (existing && existing.updated_at_ms > updatedAtMs) {
    const current = db
      .prepare(
        `SELECT favorited FROM user_favorites
          WHERE user_id = ? AND resource_kind = ? AND resource_id = ?`,
      )
      .get(userId, resourceKind, resourceId) as { favorited: number };
    return { value: current.favorited === 1, updatedAt: existing.updated_at_ms };
  }
  db.prepare(
    `INSERT INTO user_favorites (
       user_id, resource_kind, resource_id, favorited, updated_at_ms, created_at
     ) VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, resource_kind, resource_id) DO UPDATE SET
       favorited = excluded.favorited,
       updated_at_ms = excluded.updated_at_ms,
       created_at = CASE WHEN excluded.favorited = 1 THEN datetime('now')
                         ELSE user_favorites.created_at END`,
  ).run(userId, resourceKind, resourceId, favorited ? 1 : 0, updatedAtMs);
  return { value: favorited, updatedAt: updatedAtMs };
}

export function listFavoriteIds(
  db: Database,
  userId: string,
  resourceKind: "track" | "article" | "playlist" | "booklist",
): string[] {
  return (
    db
      .prepare(
        `SELECT resource_id FROM user_favorites
          WHERE user_id = ? AND resource_kind = ? AND favorited = 1
          ORDER BY updated_at_ms DESC, resource_id DESC`,
      )
      .all(userId, resourceKind) as Array<{ resource_id: string }>
  ).map((row) => row.resource_id);
}

export function isFavorited(
  db: Database,
  userId: string,
  resourceKind: "track" | "article" | "playlist" | "booklist",
  resourceId: string,
): boolean {
  const row = db
    .prepare(
      `SELECT favorited FROM user_favorites
        WHERE user_id = ? AND resource_kind = ? AND resource_id = ?`,
    )
    .get(userId, resourceKind, resourceId) as { favorited: number } | undefined;
  return row?.favorited === 1;
}

export function touchRecent(
  db: Database,
  userId: string,
  resourceKind: "track" | "article" | "playlist" | "booklist",
  resourceId: string,
  now = Date.now(),
): void {
  db.prepare(
    `INSERT INTO user_recents (
       user_id, resource_kind, resource_id, last_used_at, last_used_at_ms
     ) VALUES (?, ?, ?, datetime('now'), ?)
     ON CONFLICT(user_id, resource_kind, resource_id) DO UPDATE SET
       last_used_at = datetime('now'),
       last_used_at_ms = excluded.last_used_at_ms`,
  ).run(userId, resourceKind, resourceId, now);
}

export function listRecentIds(
  db: Database,
  userId: string,
  resourceKind: "track" | "article" | "playlist" | "booklist",
  limit = 50,
): string[] {
  return (
    db
      .prepare(
        `SELECT resource_id FROM user_recents
          WHERE user_id = ? AND resource_kind = ?
          ORDER BY last_used_at_ms DESC, resource_id DESC
          LIMIT ?`,
      )
      .all(userId, resourceKind, limit) as Array<{ resource_id: string }>
  ).map((row) => row.resource_id);
}

export function principalExists(
  db: Database,
  principal: PrincipalRef,
): boolean {
  if (principal.kind === "user") {
    return !!db.prepare("SELECT id FROM users WHERE id = ?").get(principal.id);
  }
  return !!db.prepare("SELECT id FROM groups WHERE id = ?").get(principal.id);
}

export function findQueueListId(db: Database, userId: string): string | null {
  const row = db
    .prepare("SELECT list_id FROM user_queues WHERE user_id = ?")
    .get(userId) as { list_id: string } | undefined;
  return row?.list_id ?? null;
}

export function setUserQueue(
  db: Database,
  userId: string,
  listId: string,
): void {
  db.prepare(
    `INSERT INTO user_queues (user_id, list_id) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET list_id = excluded.list_id`,
  ).run(userId, listId);
}
