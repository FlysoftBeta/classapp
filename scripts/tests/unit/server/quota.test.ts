import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {
  evictScore,
  heatNow,
  listCacheEvictionCandidates,
  touchQuotaItem,
  upsertQuotaItem,
  upsertQuotaPool,
} from "@/server/data/quota";

function memoryQuotaDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE storage_quota_pools (
      name TEXT PRIMARY KEY,
      max_weight INTEGER NOT NULL DEFAULT 0,
      target_ratio REAL NOT NULL DEFAULT 0.8,
      half_life_ms INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE storage_quota_items (
      pool TEXT NOT NULL REFERENCES storage_quota_pools(name) ON DELETE CASCADE,
      item_id TEXT NOT NULL,
      class TEXT NOT NULL CHECK (class IN ('cache', 'durable')),
      weight INTEGER NOT NULL DEFAULT 0,
      heat REAL NOT NULL DEFAULT 0,
      touched_at_ms INTEGER NOT NULL,
      pin_until_ms INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (pool, item_id)
    );
  `);
  return db;
}

test("heat decays by half after one half-life and ignores a backwards clock", () => {
  assert.equal(heatNow(8, 0, 1000, 1000), 4);
  assert.equal(heatNow(3, 50, 50, 1000), 3);
  assert.equal(heatNow(3, 100, 40, 1000), 3);
  assert.equal(heatNow(5, 0, 10, 0), 5);
});

test("eviction score is hold cost over current heat", () => {
  assert.ok(Math.abs(evictScore(100, 2) - 50) < 1e-6);
  assert.ok(evictScore(100, 0.5) > evictScore(100, 4));
});

test("cache eviction ranks cold heavy items first and skips pins and durable rows", () => {
  const db = memoryQuotaDb();
  upsertQuotaPool(db, {
    name: "media",
    maxWeight: 1000,
    targetRatio: 0.8,
    halfLifeMs: 1000,
  });
  upsertQuotaItem(db, {
    pool: "media",
    itemId: "hot-small",
    class: "cache",
    weight: 10,
    now: 0,
    heat: 8,
  });
  upsertQuotaItem(db, {
    pool: "media",
    itemId: "cold-heavy",
    class: "cache",
    weight: 100,
    now: 0,
    heat: 1,
  });
  upsertQuotaItem(db, {
    pool: "media",
    itemId: "pinned",
    class: "cache",
    weight: 1000,
    now: 0,
    heat: 0.1,
    pinUntilMs: 10_000,
  });
  upsertQuotaItem(db, {
    pool: "media",
    itemId: "durable",
    class: "durable",
    weight: 5000,
    now: 0,
    heat: 0.1,
  });
  const ranked = listCacheEvictionCandidates(db, "media", 1000, {
    now: 1000,
    limit: 10,
  });
  assert.deepEqual(
    ranked.map((item) => item.itemId),
    ["cold-heavy", "hot-small"],
  );
  db.close();
});

test("upserting an existing quota item preserves heat and does not rewind the clock", () => {
  const db = memoryQuotaDb();
  upsertQuotaPool(db, {
    name: "media",
    maxWeight: 1000,
    targetRatio: 0.8,
    halfLifeMs: 1000,
  });
  upsertQuotaItem(db, {
    pool: "media",
    itemId: "track",
    class: "cache",
    weight: 10,
    now: 5,
    heat: 4,
  });
  touchQuotaItem(db, "media", "track", 2, 15, 1000);
  upsertQuotaItem(db, {
    pool: "media",
    itemId: "track",
    class: "cache",
    weight: 20,
    now: 0,
    heat: 0,
  });
  const ranked = listCacheEvictionCandidates(db, "media", 1000, {
    now: 15,
    limit: 1,
  });
  assert.equal(ranked[0]?.weight, 20);
  assert.ok((ranked[0]?.heat ?? 0) > 4);
  db.close();
});
