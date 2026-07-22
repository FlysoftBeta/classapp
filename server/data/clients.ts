import crypto from "crypto";
import type BetterSqlite3 from "better-sqlite3";
import { parseDbTime, toDbTimestamp } from "@/shared/time";
import type { ClientIdentity } from "@/server/infra/clientIdentity";

export type ClientIdentityMethod = "mac" | "ip" | "user_agent";

export interface ClientAccessConfig {
  whitelist_enabled: boolean;
  identity_methods: ClientIdentityMethod[];
}

export interface ClientAdminListRow {
  id: string;
  created_at: string;
  persistent: number;
  remark: string;
  whitelisted: number;
  bound_user_id: string | null;
  bound_user_handle: string | null;
  ips: string | null;
  last_seen: string | null;
  konami_locked: number;
  throttled_until: string | null;
  attempts: number | null;
  mac: string | null;
  user_agent: string | null;
}

export interface ClientSessionUserRow {
  id: string;
  handle: string;
}

export interface ClientStoredState {
  persistent: boolean;
  whitelisted: boolean;
  bound_user_id: string | null;
}

function identityValue(
  identity: ClientIdentity,
  method: ClientIdentityMethod,
): string | null {
  if (method === "user_agent") return identity.userAgent;
  return identity[method];
}

function identityMatch(
  identity: ClientIdentity,
  methods: ClientIdentityMethod[],
): { clauses: string[]; values: (string | null)[] } {
  return {
    clauses: methods.map((method) =>
      method === "mac" ? "mac IS ?" : `${method} = ?`,
    ),
    values: methods.map((method) => identityValue(identity, method)),
  };
}

function createTemporaryClientId(db: BetterSqlite3.Database): string {
  for (let attempt = 0; attempt < 20; attempt++) {
    const id = `C-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
    if (!db.prepare("SELECT 1 FROM clients WHERE id = ?").get(id)) return id;
  }
  throw new Error("无法分配客户端 ID");
}

/** Resolve the configured identity tuple, creating a temporary client if new. */
export function getOrCreateClient(
  db: BetterSqlite3.Database,
  identity: ClientIdentity,
): string {
  const methods = getClientAccessConfig(db).identity_methods;
  const { clauses, values } = identityMatch(identity, methods);
  const existing = db
    .prepare(
      `SELECT client_id FROM client_associations
       WHERE ${clauses.join(" AND ")}
       ORDER BY last_seen DESC LIMIT 1`,
    )
    .get(...values) as { client_id: string } | undefined;

  if (existing) {
    recordClientAssociation(db, existing.client_id, identity);
    return existing.client_id;
  }

  const clientId = createTemporaryClientId(db);
  db.transaction(() => {
    db.prepare("INSERT INTO clients (id, konami_locked) VALUES (?, 1)").run(
      clientId,
    );
    db.prepare("INSERT INTO client_ips (client_id, ip) VALUES (?, ?)").run(
      clientId,
      identity.ip,
    );
    insertClientAssociation(db, clientId, identity);
  })();
  return clientId;
}

function insertClientAssociation(
  db: BetterSqlite3.Database,
  clientId: string,
  identity: ClientIdentity,
): void {
  db.prepare(
    `INSERT INTO client_associations (client_id, mac, ip, user_agent)
     VALUES (?, ?, ?, ?)`,
  ).run(clientId, identity.mac, identity.ip, identity.userAgent);
}

export function recordClientAssociation(
  db: BetterSqlite3.Database,
  clientId: string,
  identity: ClientIdentity,
): void {
  const existing = db
    .prepare(
      `SELECT id FROM client_associations
       WHERE client_id = ? AND mac IS ? AND ip = ? AND user_agent = ?
       ORDER BY last_seen DESC LIMIT 1`,
    )
    .get(clientId, identity.mac, identity.ip, identity.userAgent) as
    { id: number } | undefined;
  if (existing) {
    db.prepare(
      "UPDATE client_associations SET last_seen = datetime('now') WHERE id = ?",
    ).run(existing.id);
  } else {
    insertClientAssociation(db, clientId, identity);
  }
  db.prepare(
    `INSERT INTO client_ips (client_id, ip) VALUES (?, ?)
     ON CONFLICT(client_id, ip) DO UPDATE SET last_seen = datetime('now')`,
  ).run(clientId, identity.ip);
}

export function identityBelongsToClient(
  db: BetterSqlite3.Database,
  clientId: string,
  identity: ClientIdentity,
): boolean {
  const methods = getClientAccessConfig(db).identity_methods;
  const { clauses, values } = identityMatch(identity, methods);
  return !!db
    .prepare(
      `SELECT 1 FROM client_associations
       WHERE client_id = ? AND ${clauses.join(" AND ")} LIMIT 1`,
    )
    .get(clientId, ...values);
}

export function getClientAccessConfig(
  db: BetterSqlite3.Database,
): ClientAccessConfig {
  const rows = db
    .prepare(
      `SELECT key, value FROM config
       WHERE key IN ('whitelist_enabled', 'client_identity_methods')`,
    )
    .all() as { key: string; value: string }[];
  const config = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const allowed = new Set<ClientIdentityMethod>(["mac", "ip", "user_agent"]);
  const methods = (config.client_identity_methods ?? "mac,user_agent")
    .split(",")
    .filter((value): value is ClientIdentityMethod =>
      allowed.has(value as ClientIdentityMethod),
    );
  return {
    whitelist_enabled: config.whitelist_enabled === "1",
    identity_methods: methods.length ? methods : ["mac", "user_agent"],
  };
}

export function updateClientAccessConfig(
  db: BetterSqlite3.Database,
  input: Partial<ClientAccessConfig>,
): ClientAccessConfig {
  if (
    input.identity_methods !== undefined &&
    input.identity_methods.length === 0
  ) {
    throw new Error("至少选择一种客户端辨识方式");
  }
  db.transaction(() => {
    if (input.whitelist_enabled !== undefined) {
      db.prepare(
        "INSERT OR REPLACE INTO config (key, value) VALUES ('whitelist_enabled', ?)",
      ).run(input.whitelist_enabled ? "1" : "0");
    }
    if (input.identity_methods !== undefined) {
      db.prepare(
        "INSERT OR REPLACE INTO config (key, value) VALUES ('client_identity_methods', ?)",
      ).run(input.identity_methods.join(","));
    }
  })();
  return getClientAccessConfig(db);
}

export function getClientStoredState(
  db: BetterSqlite3.Database,
  clientId: string,
): ClientStoredState | null {
  const row = db
    .prepare(
      "SELECT persistent, whitelisted, bound_user_id FROM clients WHERE id = ?",
    )
    .get(clientId) as
    | { persistent: number; whitelisted: number; bound_user_id: string | null }
    | undefined;
  return row
    ? {
        persistent: row.persistent === 1,
        whitelisted: row.whitelisted === 1,
        bound_user_id: row.bound_user_id,
      }
    : null;
}

export function promoteClient(
  db: BetterSqlite3.Database,
  clientId: string,
): boolean {
  return (
    db.prepare("UPDATE clients SET persistent = 1 WHERE id = ?").run(clientId)
      .changes > 0
  );
}

export function updatePersistentClientProps(
  db: BetterSqlite3.Database,
  clientId: string,
  input: {
    remark?: string;
    whitelisted?: boolean;
    bound_user_id?: string | null;
  },
): boolean {
  const state = getClientStoredState(db, clientId);
  if (!state) return false;
  if (!state.persistent) throw new Error("请先将临时客户端转为持久客户端");

  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  if (input.remark !== undefined) {
    const remark = input.remark.trim();
    if (remark.length > 100) throw new Error("备注不能超过 100 个字符");
    sets.push("remark = ?");
    values.push(remark);
  }
  if (input.whitelisted !== undefined) {
    sets.push("whitelisted = ?");
    values.push(input.whitelisted ? 1 : 0);
  }
  if (input.bound_user_id !== undefined) {
    sets.push("bound_user_id = ?");
    values.push(input.bound_user_id);
  }
  if (sets.length === 0) return true;

  return db.transaction(() => {
    const info = db
      .prepare(`UPDATE clients SET ${sets.join(", ")} WHERE id = ?`)
      .run(...values, clientId);
    if (input.bound_user_id) {
      db.prepare(
        "DELETE FROM sessions WHERE client_id = ? AND user_id != ?",
      ).run(clientId, input.bound_user_id);
    }
    return info.changes > 0;
  })();
}

export function lockClient(db: BetterSqlite3.Database, clientId: string): void {
  db.prepare("UPDATE clients SET konami_locked = 1 WHERE id = ?").run(clientId);
}

export function unlockClient(
  db: BetterSqlite3.Database,
  clientId: string,
): void {
  db.prepare("UPDATE clients SET konami_locked = 0 WHERE id = ?").run(clientId);
}

export function getClientIdFromToken(
  db: BetterSqlite3.Database,
  token: string,
): string | null {
  const row = db
    .prepare("SELECT client_id FROM sessions WHERE token = ?")
    .get(token) as { client_id: string } | undefined;
  return row?.client_id ?? null;
}

export function isClientKonamiLocked(
  db: BetterSqlite3.Database,
  clientId: string,
): { valid: boolean; konami_locked: boolean } {
  const row = db
    .prepare("SELECT konami_locked FROM clients WHERE id = ?")
    .get(clientId) as { konami_locked: number } | undefined;
  if (!row) return { valid: false, konami_locked: true };
  return { valid: true, konami_locked: row.konami_locked === 1 };
}

export function checkClientThrottled(
  db: BetterSqlite3.Database,
  clientId: string,
): { throttled: boolean; seconds?: number } {
  const row = db
    .prepare(
      "SELECT attempts, throttled_until FROM client_attempts WHERE client_id = ?",
    )
    .get(clientId) as
    { attempts: number; throttled_until: string | null } | undefined;

  if (!row?.throttled_until) return { throttled: false };
  const throttleUntil = parseDbTime(row.throttled_until);
  const now = new Date();
  if (now < throttleUntil) {
    return {
      throttled: true,
      seconds: Math.ceil((throttleUntil.getTime() - now.getTime()) / 1000),
    };
  }
  db.prepare(
    "UPDATE client_attempts SET attempts = 0, throttled_until = NULL WHERE client_id = ?",
  ).run(clientId);
  return { throttled: false };
}

export function recordLoginAttempt(
  db: BetterSqlite3.Database,
  clientId: string,
  success: boolean,
): void {
  if (success) {
    db.prepare("DELETE FROM client_attempts WHERE client_id = ?").run(clientId);
    return;
  }
  const row = db
    .prepare("SELECT attempts FROM client_attempts WHERE client_id = ?")
    .get(clientId) as { attempts: number } | undefined;
  const attempts = (row?.attempts ?? 0) + 1;
  const throttledUntil =
    attempts >= 5 ? toDbTimestamp(Date.now() + 15 * 60 * 1000) : null;
  db.prepare(
    `INSERT INTO client_attempts (client_id, attempts, throttled_until)
     VALUES (?, ?, ?)
     ON CONFLICT(client_id) DO UPDATE SET
       attempts = excluded.attempts,
       throttled_until = excluded.throttled_until`,
  ).run(clientId, attempts, throttledUntil);
}

export function canClientLogin(
  db: BetterSqlite3.Database,
  clientId: string,
  userId: string,
): boolean {
  const state = getClientStoredState(db, clientId);
  if (!state || (state.bound_user_id && state.bound_user_id !== userId)) {
    return false;
  }
  const distinct = db
    .prepare(
      `SELECT COUNT(DISTINCT user_id) as n FROM sessions
       WHERE client_id = ?
         AND user_id != ?
         AND created_at > datetime('now', '-1 day')`,
    )
    .get(clientId, userId) as { n: number };
  return distinct.n < 2;
}

export function dedupeClientSessions(db: BetterSqlite3.Database): void {
  const duplicates = db
    .prepare(
      `SELECT client_id, user_id FROM sessions
       GROUP BY client_id, user_id HAVING COUNT(*) > 1`,
    )
    .all() as { client_id: string; user_id: string }[];
  for (const { client_id, user_id } of duplicates) {
    const keep = db
      .prepare(
        `SELECT token FROM sessions WHERE client_id = ? AND user_id = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(client_id, user_id) as { token: string };
    db.prepare(
      `DELETE FROM sessions
       WHERE client_id = ? AND user_id = ? AND token != ?`,
    ).run(client_id, user_id, keep.token);
  }
}

function clientSearchWhere(query: string): { sql: string; value?: string } {
  const normalized = query.trim();
  return normalized
    ? {
        sql: `WHERE c.id LIKE ? OR c.remark LIKE ? OR u.handle LIKE ? OR u.username LIKE ?`,
        value: `%${normalized}%`,
      }
    : { sql: "" };
}

export function countClients(db: BetterSqlite3.Database, query = ""): number {
  const where = clientSearchWhere(query);
  const row = db
    .prepare(
      `SELECT COUNT(*) as n FROM clients c
       LEFT JOIN users u ON u.id = c.bound_user_id ${where.sql}`,
    )
    .get(
      ...(where.value
        ? [where.value, where.value, where.value, where.value]
        : []),
    ) as {
    n: number;
  };
  return row.n;
}

export function listClientAdminRows(
  db: BetterSqlite3.Database,
  offset = 0,
  limit = 50,
  query = "",
): ClientAdminListRow[] {
  const where = clientSearchWhere(query);
  const searchValues = where.value
    ? [where.value, where.value, where.value, where.value]
    : [];
  return db
    .prepare(
      `SELECT c.id, c.created_at, c.persistent, c.remark, c.whitelisted,
              c.bound_user_id, u.handle AS bound_user_handle,
              c.konami_locked,
              GROUP_CONCAT(ci.ip, ',') AS ips,
              MAX(ci.last_seen) AS last_seen,
              ca.throttled_until, ca.attempts,
              latest.mac, latest.user_agent
       FROM clients c
       LEFT JOIN users u ON u.id = c.bound_user_id
       LEFT JOIN client_ips ci ON ci.client_id = c.id
       LEFT JOIN client_attempts ca ON ca.client_id = c.id
       LEFT JOIN client_associations latest ON latest.id = (
         SELECT id FROM client_associations x WHERE x.client_id = c.id
         ORDER BY x.last_seen DESC LIMIT 1
       )
       ${where.sql}
       GROUP BY c.id
       ORDER BY c.persistent ASC, last_seen DESC NULLS LAST, c.created_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...searchValues, limit, offset) as ClientAdminListRow[];
}

export function listRecentClientSessionUsers(
  db: BetterSqlite3.Database,
  clientId: string,
): ClientSessionUserRow[] {
  return db
    .prepare(
      `SELECT u.id, u.handle FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.client_id = ? AND s.created_at > datetime('now', '-1 day')
       GROUP BY u.id`,
    )
    .all(clientId) as ClientSessionUserRow[];
}

export function deleteClient(
  db: BetterSqlite3.Database,
  clientId: string,
): boolean {
  return (
    db.prepare("DELETE FROM clients WHERE id = ?").run(clientId).changes > 0
  );
}
