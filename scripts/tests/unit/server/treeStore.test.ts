import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { zipSync } from "fflate";
import { BlobStore } from "@/server/storage/blobStore";
import { TreeStore, type TreeLimits } from "@/server/storage/treeStore";

const LIMITS: TreeLimits = {
  maxBytes: 1024,
  maxFiles: 8,
  maxPathDepth: 3,
  maxArchiveBytes: 64 * 1024,
};

async function withTrees(
  run: (trees: TreeStore, blobs: BlobStore) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "classapp-tree-"));
  try {
    const blobs = new BlobStore(root);
    await run(new TreeStore(blobs), blobs);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("mutateInto publishes a new revision from an empty tree and reads it back", async () => {
  await withTrees(async (trees, blobs) => {
    const slot = await blobs.create();
    const snapshot = await trees.mutateInto(null, slot, LIMITS, (tree) => {
      tree.put("notes/a.txt", Buffer.from("hello"), "text/plain", "2026-01-01T00:00:00.000Z");
    });
    assert.equal(snapshot.revision, 1);
    assert.equal(snapshot.totalBytes, 5);
    const found = snapshot.read("notes/a.txt");
    assert.equal(found && Buffer.from(found.bytes).toString(), "hello");
    const inspected = await trees.inspect(slot.id, LIMITS);
    assert.equal(inspected.revision, 1);
    assert.deepEqual(
      inspected.files.map((file) => file.path),
      ["notes/a.txt"],
    );
  });
});

test("replacing a path drops the previous payload from the published archive", async () => {
  await withTrees(async (trees, blobs) => {
    const first = await blobs.create();
    await trees.mutateInto(null, first, LIMITS, (tree) => {
      tree.put("notes/a.txt", Buffer.from("old"), "text/plain", "2026-01-01T00:00:00.000Z");
    });
    const second = await blobs.create();
    const snapshot = await trees.mutateInto(first.id, second, LIMITS, (tree) => {
      tree.put("notes/a.txt", Buffer.from("new-text"), "text/plain", "2026-01-02T00:00:00.000Z");
    });
    assert.equal(snapshot.revision, 2);
    assert.equal(snapshot.read("notes/a.txt")?.entry.size, 8);
    assert.equal(snapshot.files.length, 1);
  });
});

test("limits reject oversized trees and traversal paths", async () => {
  await withTrees(async (trees, blobs) => {
    const slot = await blobs.create();
    await assert.rejects(
      trees.mutateInto(null, slot, LIMITS, (tree) => {
        tree.put("a.txt", Buffer.alloc(1025), "text/plain", "2026-01-01T00:00:00.000Z");
      }),
      /exceeds 1024 bytes/,
    );
    await assert.rejects(
      trees.mutateInto(null, slot, LIMITS, (tree) => {
        tree.put("../x.txt", Buffer.from("x"), "text/plain", "2026-01-01T00:00:00.000Z");
      }),
      /Invalid tree path/,
    );
  });
});

test("a named blob that is missing on disk is not an empty tree", async () => {
  await withTrees(async (trees) => {
    const missing = "01234567-89ab-4cde-8f01-23456789abcd";
    await assert.rejects(trees.inspect(missing, LIMITS));
  });
});

test("an unexpected zip member is an orphan and must be rejected", async () => {
  await withTrees(async (trees, blobs) => {
    const extra = zipSync(
      {
        "manifest.json": Buffer.from(
          `${JSON.stringify({
            format: "classapp-object-tree",
            version: 1,
            revision: 1,
            entries: [],
          }, null, 2)}\n`,
        ),
        "objects/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee": Buffer.from("orphan"),
      },
      { level: 6 },
    );
    const published = await blobs.put(extra);
    await assert.rejects(trees.inspect(published.id, LIMITS), /unexpected entry/);
  });
});

test("payload checksum and size must match the manifest", async () => {
  await withTrees(async (trees, blobs) => {
    const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const bytes = Buffer.from("payload");
    const archive = zipSync(
      {
        "manifest.json": Buffer.from(
          `${JSON.stringify({
            format: "classapp-object-tree",
            version: 1,
            revision: 1,
            entries: [
              {
                id,
                path: "a.txt",
                mime: "text/plain",
                size: bytes.byteLength,
                sha256: "0".repeat(64),
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          }, null, 2)}\n`,
        ),
        [`objects/${id}`]: bytes,
      },
      { level: 6 },
    );
    const published = await blobs.put(archive);
    await assert.rejects(trees.inspect(published.id, LIMITS), /checksum/);
  });
});
