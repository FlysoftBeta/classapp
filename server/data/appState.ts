import type BetterSqlite3 from "better-sqlite3";

export const IDLE_LOCK_TIMEOUT_MINUTES = 5;
export const PENDING_UPDATE_KEY = "pending_update_at";
export const HTTPS_REDIRECT_KEY = "https_redirect_enabled";
export const CLOUD_DEPLOY_ENABLED_KEY = "cloud_deploy_enabled";
export const UPDATE_AUTO_CHECK_KEY = "update_auto_check";
export const UPDATE_MANIFEST_URL_KEY = "update_manifest_url";

export interface CloudUpdateConfig {
  cloud_deploy_enabled: boolean;
  update_auto_check: boolean;
  update_manifest_url: string;
}

function getConfigValue(
  db: BetterSqlite3.Database,
  key: string,
): string | null {
  const row = db.prepare("SELECT value FROM config WHERE key = ?").get(key) as
    { value: string } | undefined;
  return row?.value ?? null;
}

function setConfigValue(
  db: BetterSqlite3.Database,
  key: string,
  value: string,
): void {
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(
    key,
    value,
  );
}

export function getCloudUpdateConfig(
  db: BetterSqlite3.Database,
): CloudUpdateConfig {
  return {
    cloud_deploy_enabled: getConfigValue(db, CLOUD_DEPLOY_ENABLED_KEY) === "1",
    update_auto_check: getConfigValue(db, UPDATE_AUTO_CHECK_KEY) === "1",
    update_manifest_url: getConfigValue(db, UPDATE_MANIFEST_URL_KEY) ?? "",
  };
}

export function setCloudUpdateConfig(
  db: BetterSqlite3.Database,
  input: Partial<CloudUpdateConfig>,
): CloudUpdateConfig {
  if (input.cloud_deploy_enabled !== undefined) {
    setConfigValue(
      db,
      CLOUD_DEPLOY_ENABLED_KEY,
      input.cloud_deploy_enabled ? "1" : "0",
    );
  }
  if (input.update_auto_check !== undefined) {
    setConfigValue(
      db,
      UPDATE_AUTO_CHECK_KEY,
      input.update_auto_check ? "1" : "0",
    );
  }
  if (input.update_manifest_url !== undefined) {
    setConfigValue(db, UPDATE_MANIFEST_URL_KEY, input.update_manifest_url);
  }
  return getCloudUpdateConfig(db);
}

export function getPendingUpdateAt(db: BetterSqlite3.Database): string | null {
  const row = db
    .prepare("SELECT value FROM config WHERE key = ?")
    .get(PENDING_UPDATE_KEY) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setPendingUpdateAt(
  db: BetterSqlite3.Database,
  value: string,
): void {
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(
    PENDING_UPDATE_KEY,
    value,
  );
}

export function clearPendingUpdate(db: BetterSqlite3.Database): void {
  db.prepare("DELETE FROM config WHERE key = ?").run(PENDING_UPDATE_KEY);
}

export function getIdleLockEnabled(db: BetterSqlite3.Database): boolean {
  const row = db
    .prepare("SELECT value FROM config WHERE key = 'idle_lock_enabled'")
    .get() as { value: string } | undefined;
  return row?.value === "1";
}

export function setIdleLockEnabled(
  db: BetterSqlite3.Database,
  enabled: boolean,
): void {
  db.prepare(
    "INSERT OR REPLACE INTO config (key, value) VALUES ('idle_lock_enabled', ?)",
  ).run(enabled ? "1" : "0");
}

export function getSystemLocked(db: BetterSqlite3.Database): boolean {
  const row = db
    .prepare("SELECT value FROM config WHERE key = 'system_locked'")
    .get() as { value: string } | undefined;
  return row?.value === "1";
}

export function setSystemLocked(
  db: BetterSqlite3.Database,
  locked: boolean,
): void {
  db.prepare(
    "INSERT OR REPLACE INTO config (key, value) VALUES ('system_locked', ?)",
  ).run(locked ? "1" : "0");
}

export function getHttpsRedirectEnabled(db: BetterSqlite3.Database): boolean {
  const row = db
    .prepare("SELECT value FROM config WHERE key = ?")
    .get(HTTPS_REDIRECT_KEY) as { value: string } | undefined;
  return row?.value === "1";
}

export function setHttpsRedirectEnabled(
  db: BetterSqlite3.Database,
  enabled: boolean,
): void {
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").run(
    HTTPS_REDIRECT_KEY,
    enabled ? "1" : "0",
  );
}

export function touchActivity(
  db: BetterSqlite3.Database,
  clientId: string,
): void {
  db.prepare(
    `INSERT INTO client_last_active (client_id, last_at)
     VALUES (?, datetime('now'))
     ON CONFLICT(client_id) DO UPDATE SET last_at = datetime('now')`,
  ).run(clientId);
}

export function getClientLastActiveAt(
  db: BetterSqlite3.Database,
  clientId: string,
): string | null {
  const row = db
    .prepare("SELECT last_at FROM client_last_active WHERE client_id = ?")
    .get(clientId) as { last_at: string } | undefined;
  return row?.last_at ?? null;
}

export function getMinutesSinceTimestamp(
  db: BetterSqlite3.Database,
  timestamp: string,
): number {
  const row = db
    .prepare(
      "SELECT CAST((julianday('now') - julianday(?)) * 24 * 60 AS REAL) AS minutes",
    )
    .get(timestamp) as { minutes: number };
  return row.minutes;
}
