import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { objectPath, createStorageLayout } from "@/server/storage/paths";
import { StorageRuntime } from "@/server/storage/storageRuntime";

function quotaDb(): Database.Database {
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

test("registerEvictor rejects a policy whose name does not match the pool", () => {
  const db = quotaDb();
  const runtime = new StorageRuntime(db, "/tmp/unused");
  assert.throws(
    () =>
      runtime.registerEvictor(
        "media",
        {
          name: "other",
          maxWeight: 10,
          targetRatio: 0.8,
          halfLifeMs: 1000,
        },
        async () => true,
      ),
    /does not match pool/,
  );
  db.close();
});

test("reconcileStorage GCs aged staging/trash and does not walk objects/", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "classapp-runtime-"));
  const db = quotaDb();
  try {
    const runtime = new StorageRuntime(db, root);
    const live = await runtime.blobs.put(Buffer.from("keep-me"));
    const layout = createStorageLayout(path.join(root, "storage"));
    const orphanId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    await mkdir(layout.stagingRoot, { recursive: true });
    await mkdir(layout.trashRoot, { recursive: true });
    await writeFile(path.join(layout.stagingRoot, orphanId), "orphan");
    await utimes(path.join(layout.stagingRoot, orphanId), 1, 1);
    await utimes(objectPath(layout, live.id), 1, 1);
    await runtime.reconcileStorage();
    await assert.rejects(readFile(path.join(layout.stagingRoot, orphanId)));
    assert.equal((await readFile(objectPath(layout, live.id))).toString(), "keep-me");
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
