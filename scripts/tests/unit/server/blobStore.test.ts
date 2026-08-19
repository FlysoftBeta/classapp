import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BlobStore,
  RangeNotSatisfiableError,
} from "@/server/storage/blobStore";
import { createFsGcIo, type GcDirectoryIo } from "@/server/storage/gc";
import {
  createStorageLayout,
  objectPath,
  stagingPath,
  trashPath,
} from "@/server/storage/paths";

async function withStore<T>(
  run: (store: BlobStore, root: string) => Promise<T>,
  options: ConstructorParameters<typeof BlobStore>[1] = {},
): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "classapp-blob-"));
  try {
    return await run(new BlobStore(root, options), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function readBody(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test("put then open returns the published bytes; Range uses one file's size", async () => {
  await withStore(async (store) => {
    const payload = Buffer.from("abcdefghijklmnopqrstuvwxyz");
    const info = await store.put(payload);
    assert.equal(info.bytes, 26);
    assert.equal(info.sha256, crypto.createHash("sha256").update(payload).digest("hex"));
    assert.equal(await store.size(info.id), 26);

    const full = await store.open(info.id);
    assert.equal(full.size, 26);
    assert.equal((await readBody(full.body)).toString(), payload.toString());

    const ranged = await store.open(info.id, { start: 2, end: 4 });
    assert.equal(ranged.size, 26);
    assert.equal((await readBody(ranged.body)).toString(), "cde");

    const suffix = await store.open(info.id, { suffixLength: 3 });
    assert.equal((await readBody(suffix.body)).toString(), "xyz");

    await assert.rejects(
      store.open(info.id, { start: 26 }),
      (error: unknown) => error instanceof RangeNotSatisfiableError && error.size === 26,
    );
    await assert.rejects(store.open(info.id, { suffixLength: 0 }), RangeNotSatisfiableError);
    await assert.rejects(
      store.read(info.id, 25),
      /exceeds read bound/,
    );
    assert.equal((await store.read(info.id, 26)).equals(payload), true);
  });
});

test("empty blobs are readable and unsatisfiable ranges still fail", async () => {
  await withStore(async (store) => {
    const info = await store.put(new Uint8Array());
    const opened = await store.open(info.id);
    assert.equal(opened.size, 0);
    assert.equal((await readBody(opened.body)).length, 0);
    await assert.rejects(store.open(info.id, { start: 0, end: 0 }), RangeNotSatisfiableError);
  });
});

test("in-store writeSlot exclusive-creates; a second writer cannot clobber the staging file", async () => {
  await withStore(async (store) => {
    const slot = await store.create();
    await store.writeSlot(slot, Buffer.from("first"));
    await assert.rejects(store.writeSlot(slot, Buffer.from("second")), (error: unknown) => {
      return (error as NodeJS.ErrnoException).code === "EEXIST";
    });
    const published = await slot.commit();
    assert.equal((await store.read(published.id, 16)).toString(), "first");
  });
});

test("commit of a missing staging file does not publish an objects/ entry", async () => {
  await withStore(async (store, root) => {
    const slot = await store.create();
    await assert.rejects(slot.commit(), (error: unknown) => {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    });
    const layout = createStorageLayout(root);
    await assert.rejects(stat(objectPath(layout, slot.id)), (error: unknown) => {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    });
  });
});

test("a byte-count mismatch leaves staging for TTL GC and does not publish", async () => {
  await withStore(async (store, root) => {
    const slot = await store.create();
    await writeFile(slot.path, "abcd");
    await assert.rejects(slot.commit({ expectedBytes: 3 }), /byte count mismatch/);
    const layout = createStorageLayout(root);
    assert.equal((await readFile(stagingPath(layout, slot.id))).toString(), "abcd");
    await assert.rejects(stat(objectPath(layout, slot.id)));
  });
});

test("drop is idempotent; GC reclaims aged trash and staging but never objects/", async () => {
  const now = 50_000;
  await withStore(
    async (store, root) => {
      const live = await store.put(Buffer.from("live-bytes"));
      const dropped = await store.put(Buffer.from("retired-bytes"));
      await store.drop(dropped.id);
      await store.drop(dropped.id);

      const layout = createStorageLayout(root);
      const orphanId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      await mkdir(layout.stagingRoot, { recursive: true });
      await writeFile(stagingPath(layout, orphanId), "orphan-staging");
      await utimes(stagingPath(layout, orphanId), 1, 1);
      await utimes(trashPath(layout, dropped.id), 1, 1);
      await utimes(objectPath(layout, live.id), 1, 1);

      await store.gc();

      await assert.rejects(stat(stagingPath(layout, orphanId)));
      await assert.rejects(stat(trashPath(layout, dropped.id)));
      assert.equal((await readFile(objectPath(layout, live.id))).toString(), "live-bytes");
      assert.equal((await store.read(live.id, 32)).toString(), "live-bytes");
    },
    { now: () => now, stageRetentionMs: 1_000, trashRetentionMs: 1_000 },
  );
});

test("fresh staging and trash survive GC", async () => {
  await withStore(
    async (store, root) => {
      const slot = await store.create();
      await writeFile(slot.path, "in-flight");
      const published = await store.put(Buffer.from("soon-trash"));
      await store.drop(published.id);
      await store.gc();
      const layout = createStorageLayout(root);
      assert.equal((await readFile(slot.path)).toString(), "in-flight");
      assert.equal((await readFile(trashPath(layout, published.id))).toString(), "soon-trash");
    },
    { now: () => Date.now(), stageRetentionMs: 60_000, trashRetentionMs: 60_000 },
  );
});

test("an open body keeps the original inode if the id is dropped and replaced", async () => {
  await withStore(async (store) => {
    const first = await store.put(Buffer.from("generation-one"));
    const opened = await store.open(first.id);
    await store.drop(first.id);
    const slot = await store.create(first.id);
    await store.writeSlot(slot, Buffer.from("generation-two-xxxxx"));
    await slot.commit();
    assert.equal((await readBody(opened.body)).toString(), "generation-one");
    assert.equal((await store.read(first.id, 32)).toString(), "generation-two-xxxxx");
  });
});

test("GC must not unlink a staging file recreated after the aged stat", async () => {
  const id = "11111111-2222-4333-8444-555555555555";
  const atUnlink = deferred();
  const resume = deferred();
  const fsIo = createFsGcIo();
  const gcIo: GcDirectoryIo = {
    readdir: (directory) => fsIo.readdir(directory),
    stat: (absolutePath) => fsIo.stat(absolutePath),
    async unlink(absolutePath) {
      if (absolutePath.endsWith(id)) {
        atUnlink.resolve();
        await resume.promise;
      }
      await fsIo.unlink(absolutePath);
    },
  };

  await withStore(
    async (store, root) => {
      const layout = createStorageLayout(root);
      await mkdir(layout.stagingRoot, { recursive: true });
      const staged = stagingPath(layout, id);
      await writeFile(staged, "aged-orphan");
      await utimes(staged, 1, 1);

      const gcDone = store.gc();
      await atUnlink.promise;
      await writeFile(staged, "retry-bytes");
      resume.resolve();
      await gcDone;
      assert.equal((await readFile(staged)).toString(), "retry-bytes");
    },
    {
      now: () => 50_000,
      stageRetentionMs: 1_000,
      trashRetentionMs: 1_000,
      gcIo,
    },
  );
});

test("GC must not unlink a trash file replaced by a newer drop after the aged stat", async () => {
  const atUnlink = deferred();
  const resume = deferred();
  const fsIo = createFsGcIo();
  let targetName = "";
  const gcIo: GcDirectoryIo = {
    readdir: (directory) => fsIo.readdir(directory),
    stat: (absolutePath) => fsIo.stat(absolutePath),
    async unlink(absolutePath) {
      if (absolutePath.includes(`${path.sep}trash${path.sep}`)) {
        targetName = path.basename(absolutePath);
        atUnlink.resolve();
        await resume.promise;
      }
      await fsIo.unlink(absolutePath);
    },
  };

  await withStore(
    async (store, root) => {
      const first = await store.put(Buffer.from("old-generation"));
      await store.drop(first.id);
      const layout = createStorageLayout(root);
      await utimes(trashPath(layout, first.id), 1, 1);

      const gcDone = store.gc();
      await atUnlink.promise;
      const replacement = await store.put(Buffer.from("new-generation"), {
        expectedBytes: 14,
      });
      assert.equal(replacement.id !== first.id, true);
      await store.drop(first.id);
      const slot = await store.create(first.id);
      await store.writeSlot(slot, Buffer.from("reused-id-bytes"));
      await slot.commit();
      await store.drop(first.id);
      resume.resolve();
      await gcDone;
      assert.equal(targetName, first.id);
      assert.equal(
        (await readFile(trashPath(layout, first.id))).toString(),
        "reused-id-bytes",
      );
    },
    {
      now: () => 50_000,
      stageRetentionMs: 1_000,
      trashRetentionMs: 1_000,
      gcIo,
    },
  );
});

test("copyFrom rejects a directory and publishes a regular file", async () => {
  await withStore(async (store, root) => {
    await assert.rejects(store.copyFrom(root), /not a file/);
    const source = path.join(root, "source.bin");
    await writeFile(source, "copied");
    const info = await store.copyFrom(source, { expectedBytes: 6 });
    assert.equal((await store.read(info.id, 16)).toString(), "copied");
    await assert.rejects(
      store.copyFrom(source, { expectedBytes: 1 }),
      /byte count mismatch/,
    );
  });
});

test("invalid checksum input is rejected before publish", async () => {
  await withStore(async (store) => {
    const slot = await store.create();
    await writeFile(slot.path, "x");
    await assert.rejects(slot.commit({ sha256: "nope" }), /checksum is invalid/);
  });
});
