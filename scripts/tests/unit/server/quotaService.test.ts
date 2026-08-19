import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {
  findQuotaItem,
  upsertQuotaItem,
  upsertQuotaPool,
} from "@/server/data/quota";
import {
  QuotaService,
  quotaCandidateIsCurrent,
} from "@/server/storage/quotaService";

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

function mediaPool(db: Database.Database, maxWeight = 50) {
  upsertQuotaPool(db, {
    name: "media",
    maxWeight,
    targetRatio: 0.8,
    halfLifeMs: 1000,
  });
}

test("quotaCandidateIsCurrent rejects touch, rematerialize, class, and future pins", () => {
  const candidate = {
    pool: "media",
    itemId: "t",
    class: "cache" as const,
    weight: 10,
    heat: 2,
    touchedAtMs: 5,
    pinUntilMs: 0,
    createdAtMs: 1,
  };
  assert.equal(quotaCandidateIsCurrent(candidate, null, 10), false);
  assert.equal(quotaCandidateIsCurrent(candidate, candidate, 10), true);
  assert.equal(
    quotaCandidateIsCurrent(candidate, { ...candidate, heat: 3 }, 10),
    false,
  );
  assert.equal(
    quotaCandidateIsCurrent(candidate, { ...candidate, touchedAtMs: 8 }, 10),
    false,
  );
  assert.equal(
    quotaCandidateIsCurrent(candidate, { ...candidate, weight: 11 }, 10),
    false,
  );
  assert.equal(
    quotaCandidateIsCurrent(candidate, { ...candidate, class: "durable" }, 10),
    false,
  );
  assert.equal(
    quotaCandidateIsCurrent(candidate, { ...candidate, pinUntilMs: 11 }, 10),
    false,
  );
  assert.equal(
    quotaCandidateIsCurrent(candidate, { ...candidate, pinUntilMs: 10 }, 10),
    true,
  );
});

test("reconcile ignores durable rows, zero-max pools, and evictor refusals", async () => {
  const db = memoryQuotaDb();
  mediaPool(db, 10);
  upsertQuotaPool(db, {
    name: "disabled",
    maxWeight: 0,
    targetRatio: 0.8,
    halfLifeMs: 1000,
  });
  upsertQuotaItem(db, {
    pool: "media",
    itemId: "durable",
    class: "durable",
    weight: 100,
    now: 0,
    heat: 0.1,
  });
  upsertQuotaItem(db, {
    pool: "disabled",
    itemId: "cache",
    class: "cache",
    weight: 100,
    now: 0,
    heat: 0.1,
  });
  upsertQuotaItem(db, {
    pool: "media",
    itemId: "cold",
    class: "cache",
    weight: 40,
    now: 0,
    heat: 0.1,
  });
  const quota = new QuotaService(db);
  const asked: string[] = [];
  const results = await quota.reconcile(
    new Map([
      [
        "media",
        async (item) => {
          asked.push(item.itemId);
          return false;
        },
      ],
      [
        "disabled",
        async () => {
          throw new Error("disabled pool must not evict");
        },
      ],
    ]),
    { now: 1000 },
  );
  assert.deepEqual(asked, ["cold"]);
  assert.deepEqual(results, []);
  assert.ok(findQuotaItem(db, "media", "cold"));
  db.close();
});

test("reconcile skips a candidate touched after listing in the same sweep", async () => {
  const db = memoryQuotaDb();
  mediaPool(db, 50);
  upsertQuotaItem(db, {
    pool: "media",
    itemId: "cold",
    class: "cache",
    weight: 80,
    now: 0,
    heat: 0.1,
  });
  upsertQuotaItem(db, {
    pool: "media",
    itemId: "warm",
    class: "cache",
    weight: 80,
    now: 0,
    heat: 8,
  });
  const quota = new QuotaService(db);
  const asked: string[] = [];
  const results = await quota.reconcile(
    new Map([
      [
        "media",
        async (item) => {
          asked.push(item.itemId);
          if (item.itemId === "cold") {
            quota.touch("media", "warm", 10, 5000);
            return false;
          }
          throw new Error(`touched candidate ${item.itemId} must not be evicted`);
        },
      ],
    ]),
    { now: 1000 },
  );
  assert.deepEqual(asked, ["cold"]);
  assert.deepEqual(results, []);
  assert.ok(findQuotaItem(db, "media", "warm"));
  assert.ok(findQuotaItem(db, "media", "cold"));
  db.close();
});

test("reconcile must not count a rematerialize that lands during the evictor as reclaimed", async () => {
  const db = memoryQuotaDb();
  mediaPool(db, 50);
  upsertQuotaItem(db, {
    pool: "media",
    itemId: "track",
    class: "cache",
    weight: 80,
    now: 0,
    heat: 1,
  });
  const quota = new QuotaService(db);
  const results = await quota.reconcile(
    new Map([
      [
        "media",
        async (item) => {
          quota.account("media", item.itemId, {
            weight: 12,
            class: "cache",
            now: 4000,
          });
          return true;
        },
      ],
    ]),
    { now: 1000 },
  );
  const row = findQuotaItem(db, "media", "track");
  assert.ok(row);
  assert.equal(row.weight, 12);
  assert.deepEqual(results, []);
  db.close();
});

test("a stale evictor must not release a rematerialized ledger row", async () => {
  const db = memoryQuotaDb();
  mediaPool(db, 50);
  upsertQuotaItem(db, {
    pool: "media",
    itemId: "track",
    class: "cache",
    weight: 80,
    now: 0,
    heat: 1,
  });
  const quota = new QuotaService(db);
  await quota.reconcile(
    new Map([
      [
        "media",
        async (item) => {
          quota.account("media", item.itemId, {
            weight: 12,
            class: "cache",
            now: 4000,
          });
          quota.release("media", item.itemId);
          return true;
        },
      ],
    ]),
    { now: 1000 },
  );
  const row = findQuotaItem(db, "media", "track");
  assert.ok(row, "rematerialized ledger row was deleted from a stale snapshot");
  assert.equal(row?.weight, 12);
  db.close();
});

test("touch on an unknown pool or item does not throw; account records cache usage", () => {
  const db = memoryQuotaDb();
  mediaPool(db, 100);
  const quota = new QuotaService(db);
  quota.touch("missing-pool", "x", 1, 1);
  quota.touch("media", "missing-item", 1, 1);
  quota.account("media", "a", { weight: 40, class: "cache", now: 1 });
  quota.account("media", "b", { weight: 10, class: "durable", now: 1 });
  assert.equal(quota.cacheUsage("media"), 40);
  quota.release("media", "a");
  assert.equal(quota.cacheUsage("media"), 0);
  db.close();
});
