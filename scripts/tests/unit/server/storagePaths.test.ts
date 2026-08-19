import assert from "node:assert/strict";
import test from "node:test";
import {
  createStorageLayout,
  normalizeBlobId,
  normalizeTreePath,
  objectPath,
  stagingPath,
  trashPath,
} from "@/server/storage/paths";

const UUID = "550e8400-e29b-41d4-a716-446655440000";

test("blob ids are allocated UUIDs and are stored in lowercase", () => {
  assert.equal(normalizeBlobId(UUID.toUpperCase()), UUID);
  assert.throws(() => normalizeBlobId("not-a-uuid"), /Invalid blob id/);
  assert.throws(() => normalizeBlobId(""), /Invalid blob id/);
  assert.throws(
    () => normalizeBlobId("../" + UUID),
    /Invalid blob id/,
  );
  assert.throws(
    () => normalizeBlobId("00000000-0000-0000-0000-000000000000"),
    /Invalid blob id/,
  );
  assert.throws(
    () => normalizeBlobId("550e8400-e29b-91d4-a716-446655440000"),
    /Invalid blob id/,
  );
});

test("object paths shard from the compact hex form and never use the raw id as a directory", () => {
  const layout = createStorageLayout("/tmp/classapp-storage");
  const published = objectPath(layout, UUID.toUpperCase());
  assert.equal(
    published,
    "/tmp/classapp-storage/objects/55/0e/550e8400-e29b-41d4-a716-446655440000",
  );
  assert.equal(
    stagingPath(layout, UUID),
    "/tmp/classapp-storage/staging/550e8400-e29b-41d4-a716-446655440000",
  );
  assert.equal(
    trashPath(layout, UUID),
    "/tmp/classapp-storage/trash/550e8400-e29b-41d4-a716-446655440000",
  );
});

test("tree paths reject traversal, Windows prefixes, empty segments, and over-long values", () => {
  assert.equal(normalizeTreePath("notes/today.md"), "notes/today.md");
  assert.throws(() => normalizeTreePath(""), /Invalid tree path length/);
  assert.throws(() => normalizeTreePath("a".repeat(1025)), /Invalid tree path length/);
  assert.throws(() => normalizeTreePath("notes\\today.md"), /Invalid tree path characters/);
  assert.throws(() => normalizeTreePath("notes/\u0000x"), /Invalid tree path characters/);
  assert.throws(() => normalizeTreePath("."), /Invalid tree path/);
  assert.throws(() => normalizeTreePath(".."), /Invalid tree path/);
  assert.throws(() => normalizeTreePath("../secret"), /Invalid tree path/);
  assert.throws(() => normalizeTreePath("notes/../secret"), /Invalid tree path/);
  assert.throws(() => normalizeTreePath("/abs/path"), /Invalid tree path/);
  assert.throws(() => normalizeTreePath("C:/windows"), /Invalid tree path/);
  assert.throws(() => normalizeTreePath("notes//today.md"), /Invalid tree path/);
  assert.throws(() => normalizeTreePath("a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q"), /Invalid tree path segment/);
});
