import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import {
  createStorageLayout,
  normalizeBlobId,
  normalizeTreePath,
  objectPath,
} from "@/server/storage/paths";

test("blob ids must be allocated UUID strings", () => {
  const id = "550e8400-e29b-41d4-a716-446655440000";
  assert.equal(normalizeBlobId(id), id);
  assert.equal(
    normalizeBlobId("550E8400-E29B-41D4-A716-446655440000"),
    id,
  );
  assert.throws(() => normalizeBlobId("not-a-uuid"));
  assert.throws(() => normalizeBlobId("../objects/x"));
});

test("object paths shard compact hex and never embed owner keys", () => {
  const layout = createStorageLayout(path.join(os.tmpdir(), "storage"));
  const id = "550e8400-e29b-41d4-a716-446655440000";
  const stored = objectPath(layout, id);
  assert.match(stored, /[/\\]objects[/\\]55[/\\]0e[/\\]550e8400-e29b-41d4-a716-446655440000$/);
});

test("tree paths reject traversal, absolute, and empty segments", () => {
  assert.equal(normalizeTreePath("a/b.txt"), "a/b.txt");
  assert.throws(() => normalizeTreePath("../secret"));
  assert.throws(() => normalizeTreePath("/etc/passwd"));
  assert.throws(() => normalizeTreePath("a//b"));
  assert.throws(() => normalizeTreePath("a/./b"));
  assert.throws(() => normalizeTreePath("C:\\windows"));
  assert.throws(() => normalizeTreePath(""));
});
