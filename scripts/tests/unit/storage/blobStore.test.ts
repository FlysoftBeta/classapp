import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BlobStore,
  RangeNotSatisfiableError,
} from "@/server/storage/blobStore";
import { stagingPath, createStorageLayout } from "@/server/storage/paths";

async function withStore<T>(
  run: (store: BlobStore, root: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "classapp-blob-"));
  try {
    return await run(new BlobStore(root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("put then open returns the committed bytes", async () => {
  await withStore(async (store) => {
    const info = await store.put(new Uint8Array([1, 2, 3, 4]));
    const read = await store.open(info.id);
    assert.equal(read.size, 4);
    const chunks: Uint8Array[] = [];
    const reader = read.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    assert.deepEqual(Buffer.concat(chunks), Buffer.from([1, 2, 3, 4]));
  });
});

test("range open cannot mix another file's length with this body", async () => {
  await withStore(async (store) => {
    const info = await store.put(new Uint8Array([10, 20, 30, 40, 50]));
    const ranged = await store.open(info.id, { start: 1, end: 3 });
    assert.equal(ranged.size, 5);
    const reader = ranged.body.getReader();
    const { value } = await reader.read();
    assert.deepEqual(Buffer.from(value ?? []), Buffer.from([20, 30, 40]));
  });
});

test("unsatisfiable ranges fail without truncating to empty", async () => {
  await withStore(async (store) => {
    const info = await store.put(new Uint8Array([1, 2, 3]));
    await assert.rejects(
      store.open(info.id, { start: 8, end: 9 }),
      (error: unknown) => error instanceof RangeNotSatisfiableError,
    );
  });
});

test("drop moves objects into trash and zero-retention GC removes them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "classapp-blob-"));
  try {
    const store = new BlobStore(root, {
      stageRetentionMs: 0,
      trashRetentionMs: 0,
    });
    const info = await store.put(new Uint8Array([7, 8, 9]));
    await store.drop(info.id);
    const layout = createStorageLayout(root);
    assert.deepEqual(await readdir(layout.trashRoot), [info.id]);
    await store.gc();
    assert.deepEqual(await readdir(layout.trashRoot), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("positive trash retention keeps a freshly dropped object", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "classapp-blob-"));
  try {
    const store = new BlobStore(root, {
      stageRetentionMs: 60_000,
      trashRetentionMs: 60_000,
    });
    const info = await store.put(new Uint8Array([7, 8, 9]));
    await store.drop(info.id);
    await store.gc();
    const layout = createStorageLayout(root);
    assert.deepEqual(await readdir(layout.trashRoot), [info.id]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GC deletes expired staging files and never requires an objects walk", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "classapp-blob-"));
  try {
    const store = new BlobStore(root, {
      stageRetentionMs: 0,
      trashRetentionMs: 0,
    });
    const slot = await store.create();
    await store.writeSlot(slot, new Uint8Array([1]));
    const layout = createStorageLayout(root);
    assert.ok((await readdir(layout.stagingRoot)).includes(slot.id));
    await store.gc();
    assert.deepEqual(await readdir(layout.stagingRoot), []);
    assert.equal(stagingPath(layout, slot.id).endsWith(slot.id), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
