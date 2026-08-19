import assert from "node:assert/strict";
import test from "node:test";
import {
  gcAgedDirectory,
  gcCutoffMs,
  isReclaimableMtime,
  type GcDirectoryIo,
} from "@/server/storage/gc";

test("GC cutoff is now minus retention and reclaim is inclusive at the boundary", () => {
  assert.equal(gcCutoffMs(10_000, 1_000), 9_000);
  assert.equal(isReclaimableMtime(9_000, 9_000), true);
  assert.equal(isReclaimableMtime(8_999, 9_000), true);
  assert.equal(isReclaimableMtime(9_001, 9_000), false);
  assert.throws(() => gcCutoffMs(Number.NaN, 1), /finite/);
});

test("missing directories are already clean; nested directories are not walked", async () => {
  const missing: GcDirectoryIo = {
    async readdir() {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    async stat() {
      throw new Error("stat must not run");
    },
    async unlink() {
      throw new Error("unlink must not run");
    },
  };
  await gcAgedDirectory("/tmp/missing-staging", 0, missing);

  const seen: string[] = [];
  const nested: GcDirectoryIo = {
    async readdir() {
      return ["subdir"];
    },
    async stat(absolutePath) {
      seen.push(absolutePath);
      return { isFile: false, mtimeMs: 0 };
    },
    async unlink() {
      throw new Error("directories must not be unlinked");
    },
  };
  await gcAgedDirectory("/tmp/staging", 0, nested);
  assert.deepEqual(seen, ["/tmp/staging/subdir"]);
});

test("an in-flight recreate after the aged stat must keep the new generation", async () => {
  let generation = 1;
  let unlinkedGeneration: number | null = null;
  const io: GcDirectoryIo = {
    async readdir() {
      return ["550e8400-e29b-41d4-a716-446655440000"];
    },
    async stat() {
      const snapshot = { isFile: true, mtimeMs: 0 };
      generation = 2;
      return snapshot;
    },
    async unlink() {
      unlinkedGeneration = generation;
    },
  };
  await gcAgedDirectory("/tmp/staging", 1_000, io);
  assert.equal(unlinkedGeneration, null);
});

test("a mtime touch after the aged stat must keep the file", async () => {
  let mtimeMs = 0;
  let unlinkedMtime: number | null = null;
  const io: GcDirectoryIo = {
    async readdir() {
      return ["aged"];
    },
    async stat() {
      const snapshot = { isFile: true, mtimeMs };
      mtimeMs = 50_000;
      return snapshot;
    },
    async unlink() {
      unlinkedMtime = mtimeMs;
    },
  };
  await gcAgedDirectory("/tmp/staging", 1_000, io);
  assert.equal(unlinkedMtime, null);
});

test("non-ENOENT unlink failures must surface", async () => {
  const io: GcDirectoryIo = {
    async readdir() {
      return ["stuck"];
    },
    async stat() {
      return { isFile: true, mtimeMs: 0 };
    },
    async unlink() {
      throw Object.assign(new Error("busy"), { code: "EBUSY" });
    },
  };
  await assert.rejects(gcAgedDirectory("/tmp/staging", 1_000, io), /busy/);
});
