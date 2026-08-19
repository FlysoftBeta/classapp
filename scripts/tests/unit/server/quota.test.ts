import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {
  evictScore,
  findQuotaItem,
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

test("touch of a missing item is a no-op; stacked touches add intensity after decay", () => {
  const db = memoryQuotaDb();
  upsertQuotaPool(db, {
    name: "media",
    maxWeight: 100,
    targetRatio: 0.8,
    halfLifeMs: 1000,
  });
  touchQuotaItem(db, "media", "absent", 5, 10, 1000);
  assert.equal(findQuotaItem(db, "media", "absent"), null);

  upsertQuotaItem(db, {
    pool: "media",
    itemId: "track",
    class: "cache",
    weight: 10,
    now: 0,
    heat: 2,
  });
  touchQuotaItem(db, "media", "track", 1, 1000, 1000);
  const afterFirst = findQuotaItem(db, "media", "track");
  assert.equal(afterFirst?.heat, 2);
  touchQuotaItem(db, "media", "track", 3, 1000, 1000);
  assert.equal(findQuotaItem(db, "media", "track")?.heat, 5);
  touchQuotaItem(db, "media", "track", 1, 0, 1000);
  assert.equal(findQuotaItem(db, "media", "track")?.touchedAtMs, 1000);
  db.close();
});

test("pins, zero weight, and durable rows are not eviction candidates; a pin that expires at now is eligible", () => {
  const db = memoryQuotaDb();
  upsertQuotaPool(db, {
    name: "media",
    maxWeight: 10,
    targetRatio: 0.8,
    halfLifeMs: 1000,
  });
  upsertQuotaItem(db, {
    pool: "media",
    itemId: "zero",
    class: "cache",
    weight: 0,
    now: 0,
    heat: 0.1,
  });
  upsertQuotaItem(db, {
    pool: "media",
    itemId: "pinned-future",
    class: "cache",
    weight: 50,
    now: 0,
    heat: 0.1,
    pinUntilMs: 11,
  });
  upsertQuotaItem(db, {
    pool: "media",
    itemId: "pin-expires",
    class: "cache",
    weight: 40,
    now: 0,
    heat: 0.1,
    pinUntilMs: 10,
  });
  const ranked = listCacheEvictionCandidates(db, "media", 1000, {
    now: 10,
    limit: 10,
  });
  assert.deepEqual(
    ranked.map((item) => item.itemId),
    ["pin-expires"],
  );
  db.close();
});

test("upsert can extend a pin but must not shorten it or rewind heat", () => {
  const db = memoryQuotaDb();
  upsertQuotaPool(db, {
    name: "media",
    maxWeight: 10,
    targetRatio: 0.8,
    halfLifeMs: 1000,
  });
  upsertQuotaItem(db, {
    pool: "media",
    itemId: "track",
    class: "cache",
    weight: 10,
    now: 5,
    heat: 9,
    pinUntilMs: 100,
  });
  upsertQuotaItem(db, {
    pool: "media",
    itemId: "track",
    class: "cache",
    weight: 10,
    now: 6,
    heat: 0,
    pinUntilMs: 50,
  });
  const kept = findQuotaItem(db, "media", "track");
  assert.equal(kept?.pinUntilMs, 100);
  assert.equal(kept?.heat, 9);
  upsertQuotaItem(db, {
    pool: "media",
    itemId: "track",
    class: "cache",
    weight: 10,
    now: 6,
    pinUntilMs: 200,
  });
  assert.equal(findQuotaItem(db, "media", "track")?.pinUntilMs, 200);
  db.close();
});

test("negative weight and intensity are rejected; equal eviction scores break ties by touch then id", () => {
  const db = memoryQuotaDb();
  upsertQuotaPool(db, {
    name: "media",
    maxWeight: 10,
    targetRatio: 0.8,
    halfLifeMs: 1000,
  });
  assert.throws(
    () =>
      upsertQuotaItem(db, {
        pool: "media",
        itemId: "bad",
        class: "cache",
        weight: -1,
        now: 0,
      }),
    /non-negative/,
  );
  upsertQuotaItem(db, {
    pool: "media",
    itemId: "b",
    class: "cache",
    weight: 10,
    now: 1,
    heat: 1,
  });
  upsertQuotaItem(db, {
    pool: "media",
    itemId: "a",
    class: "cache",
    weight: 10,
    now: 1,
    heat: 1,
  });
  assert.throws(
    () => touchQuotaItem(db, "media", "a", -1, 1, 1000),
    /non-negative/,
  );
  assert.deepEqual(
    listCacheEvictionCandidates(db, "media", 1000, { now: 1, limit: 2 }).map(
      (item) => item.itemId,
    ),
    ["a", "b"],
  );
  db.close();
});
