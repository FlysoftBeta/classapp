import assert from "node:assert/strict";
import test from "node:test";
import { QuotaService } from "@/server/storage/quotaService";
import {
  findQuotaItem,
  listCacheEvictionCandidates,
} from "@/server/data/quota";
import { openQuotaMemory } from "../../harness/quotaMemory";

const POOL = "cache-pool";

test("reconcile never evicts durable rows and skips unexpired pins", async () => {
  const db = openQuotaMemory();
  const quota = new QuotaService(db);
  quota.configure({
    name: POOL,
    maxWeight: 100,
    targetRatio: 0.5,
    halfLifeMs: 1_000,
  });
  quota.account(POOL, "durable", { class: "durable", weight: 80, now: 0 });
  quota.account(POOL, "pinned", {
    class: "cache",
    weight: 80,
    now: 0,
    pinUntilMs: 5_000,
  });
  quota.account(POOL, "cold", { class: "cache", weight: 80, now: 0, heat: 0.1 });

  const seen: string[] = [];
  const results = await quota.reconcile(
    new Map([
      [
        POOL,
        async (item) => {
          seen.push(item.itemId);
          quota.release(POOL, item.itemId);
          return true;
        },
      ],
    ]),
    { now: 1_000 },
  );

  assert.deepEqual(seen, ["cold"]);
  assert.equal(results[0]?.evicted, 1);
  assert.equal(findQuotaItem(db, POOL, "durable")?.class, "durable");
  assert.ok(findQuotaItem(db, POOL, "pinned"));
  assert.equal(findQuotaItem(db, POOL, "cold"), null);
  db.close();
});

test("colder cache items are ranked ahead of hotter ones of equal weight", () => {
  const db = openQuotaMemory();
  const quota = new QuotaService(db);
  quota.configure({
    name: POOL,
    maxWeight: 10,
    targetRatio: 0.5,
    halfLifeMs: 1_000,
  });
  quota.account(POOL, "hot", { class: "cache", weight: 50, now: 0, heat: 8 });
  quota.account(POOL, "cold", { class: "cache", weight: 50, now: 0, heat: 1 });
  const candidates = listCacheEvictionCandidates(db, POOL, 1_000, {
    now: 0,
    limit: 10,
  });
  assert.deepEqual(
    candidates.map((item) => item.itemId),
    ["cold", "hot"],
  );
  db.close();
});

test("a failed evictor does not count as progress and stops the sweep", async () => {
  const db = openQuotaMemory();
  const quota = new QuotaService(db);
  quota.configure({
    name: POOL,
    maxWeight: 10,
    targetRatio: 0.5,
    halfLifeMs: 1_000,
  });
  quota.account(POOL, "stuck", { class: "cache", weight: 50, now: 0 });
  const results = await quota.reconcile(
    new Map([[POOL, async () => false]]),
    { now: 0 },
  );
  assert.deepEqual(results, []);
  assert.ok(findQuotaItem(db, POOL, "stuck"));
  db.close();
});

test("touching an item preserves heat across a later weight refresh", () => {
  const db = openQuotaMemory();
  const quota = new QuotaService(db);
  quota.configure({
    name: POOL,
    maxWeight: 1_000,
    targetRatio: 0.8,
    halfLifeMs: 1_000,
  });
  quota.account(POOL, "item", { class: "cache", weight: 10, now: 0, heat: 1 });
  quota.touch(POOL, "item", 4, 0);
  quota.account(POOL, "item", { class: "cache", weight: 20, now: 500 });
  const item = findQuotaItem(db, POOL, "item");
  assert.equal(item?.weight, 20);
  assert.equal(item?.heat, 5);
  assert.equal(item?.touchedAtMs, 0);
  db.close();
});
