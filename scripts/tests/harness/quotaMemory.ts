import Database from "better-sqlite3";

/** In-memory quota tables matching the current server schema. */
export function openQuotaMemory(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE storage_quota_pools (
      name          TEXT PRIMARY KEY,
      max_weight    INTEGER NOT NULL DEFAULT 0 CHECK (max_weight >= 0),
      target_ratio  REAL NOT NULL DEFAULT 0.8 CHECK (target_ratio > 0 AND target_ratio <= 1),
      half_life_ms  INTEGER NOT NULL CHECK (half_life_ms > 0),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE storage_quota_items (
      pool           TEXT NOT NULL REFERENCES storage_quota_pools(name) ON DELETE CASCADE,
      item_id        TEXT NOT NULL,
      class          TEXT NOT NULL CHECK (class IN ('cache', 'durable')),
      weight         INTEGER NOT NULL DEFAULT 0 CHECK (weight >= 0),
      heat           REAL NOT NULL DEFAULT 0 CHECK (heat >= 0),
      touched_at_ms  INTEGER NOT NULL,
      pin_until_ms   INTEGER NOT NULL DEFAULT 0 CHECK (pin_until_ms >= 0),
      created_at_ms  INTEGER NOT NULL,
      PRIMARY KEY (pool, item_id)
    );
  `);
  return db;
}
