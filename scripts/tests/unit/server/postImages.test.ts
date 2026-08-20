import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import jpegJs from "jpeg-js";
import { BlobStore } from "@/server/storage/blobStore";
import { QuotaService } from "@/server/storage/quotaService";
import {
  POST_IMAGE_THUMB_POOL,
  PostImageService,
} from "@/server/services/postImagesService";

function jpegFile(width: number, height: number): File {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 180;
    data[i + 1] = 60;
    data[i + 2] = 20;
    data[i + 3] = 255;
  }
  const encoded = jpegJs.encode({ data, width, height }, 80);
  const source =
    encoded.data instanceof Uint8Array
      ? encoded.data
      : new Uint8Array(encoded.data);
  const copy = new ArrayBuffer(source.byteLength);
  new Uint8Array(copy).set(source);
  return new File([copy], "photo.jpg", { type: "image/jpeg" });
}

async function withImages<T>(
  run: (images: PostImageService, db: Database.Database) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "classapp-post-images-"));
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE posts (
      id TEXT PRIMARY KEY,
      deleted_at TEXT
    );
    CREATE TABLE post_images (
      id          TEXT PRIMARY KEY,
      post_id     TEXT UNIQUE REFERENCES posts(id),
      blob_id     TEXT NOT NULL,
      mime        TEXT NOT NULL,
      bytes       INTEGER NOT NULL CHECK (bytes > 0),
      width       INTEGER NOT NULL CHECK (width > 0),
      height      INTEGER NOT NULL CHECK (height > 0),
      sha256      TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE post_image_thumbs (
      image_id    TEXT PRIMARY KEY REFERENCES post_images(id) ON DELETE CASCADE,
      blob_id     TEXT,
      mime        TEXT,
      bytes       INTEGER NOT NULL DEFAULT 0 CHECK (bytes >= 0),
      width       INTEGER NOT NULL DEFAULT 0 CHECK (width >= 0),
      height      INTEGER NOT NULL DEFAULT 0 CHECK (height >= 0),
      sha256      TEXT,
      state       TEXT NOT NULL CHECK (state IN ('absent', 'staging', 'ready', 'failed')),
      generation  INTEGER NOT NULL DEFAULT 0,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
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
  const blobs = new BlobStore(root);
  const images = new PostImageService(db, blobs);
  try {
    return await run(images, db);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function attachPublished(
  images: PostImageService,
  db: Database.Database,
  file: File,
): Promise<string> {
  const ingested = await images.ingest(file);
  const postId = crypto.randomUUID();
  db.prepare("INSERT INTO posts (id) VALUES (?)").run(postId);
  images.attach(ingested.id, postId);
  return ingested.id;
}

async function materialize(images: PostImageService, imageId: string): Promise<void> {
  const started = images.beginThumbMaterialization(imageId);
  assert.equal(started.kind, "start");
  if (started.kind !== "start") return;
  const published = await images.materializeThumb(imageId, started.generation);
  assert.equal(published, true);
}

test("ingest persists the original and attach binds a post", async () => {
  await withImages(async (images, db) => {
    const ingested = await images.ingest(jpegFile(24, 16));
    assert.equal(ingested.mime, "image/jpeg");
    assert.equal(ingested.width, 24);
    assert.equal(ingested.height, 16);
    const staging = images.lookup(ingested.id);
    assert.equal(staging?.postId, null);
    const postId = crypto.randomUUID();
    db.prepare("INSERT INTO posts (id) VALUES (?)").run(postId);
    images.attach(ingested.id, postId);
    const bound = images.get(ingested.id);
    assert.equal(bound.postId, postId);
    assert.equal(bound.thumb.state, "absent");
  });
});

test("thumbnail materialization is a rebuildable cache view", async () => {
  await withImages(async (images, db) => {
    const imageId = await attachPublished(images, db, jpegFile(400, 200));
    await materialize(images, imageId);
    const ready = await images.openThumb(imageId);
    assert.ok(ready);
    assert.equal(ready.image.thumb.state, "ready");
    assert.equal(ready.image.thumb.width, 320);
    assert.equal(ready.image.thumb.height, 160);
    const dropped = await images.evictThumb(imageId);
    assert.equal(dropped, true);
    assert.equal(await images.openThumb(imageId), null);
    assert.equal(images.get(imageId).thumb.state, "absent");
    await materialize(images, imageId);
    const rebuilt = await images.openThumb(imageId);
    assert.ok(rebuilt);
    assert.equal(rebuilt.image.thumb.state, "ready");
  });
});

test("quota cache sweep can evict a published thumbnail", async () => {
  await withImages(async (images, db) => {
    const imageId = await attachPublished(images, db, jpegFile(80, 80));
    await materialize(images, imageId);
    const quota = new QuotaService(db);
    quota.configure({
      name: POST_IMAGE_THUMB_POOL,
      maxWeight: 1,
      targetRatio: 0.8,
      halfLifeMs: 1000,
    });
    const results = await quota.reconcile(
      new Map([
        [POST_IMAGE_THUMB_POOL, (item) => images.evictThumb(item.itemId, item)],
      ]),
      { now: Date.now() + 11 * 60_000 },
    );
    assert.ok(results.some((row) => row.pool === POST_IMAGE_THUMB_POOL && row.evicted >= 1));
    assert.equal(images.get(imageId).thumb.state, "absent");
    assert.ok(images.lookup(imageId)?.blobId);
  });
});

test("reconcile drops expired staging originals", async () => {
  await withImages(async (images, db) => {
    const ingested = await images.ingest(jpegFile(12, 12));
    db.prepare(
      `UPDATE post_images SET created_at = datetime('now', '-40 minutes') WHERE id = ?`,
    ).run(ingested.id);
    const reclaimed = await images.reconcile();
    assert.ok(reclaimed >= 1);
    assert.equal(images.lookup(ingested.id), null);
  });
});

test("rejects a non-image payload", async () => {
  await withImages(async (images) => {
    const file = new File([Buffer.from("hello")], "note.txt", { type: "text/plain" });
    await assert.rejects(() => images.ingest(file), /图片/);
  });
});
