import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  isRenderArchiveEntryName,
  validateRenderArchiveContents,
} from "@/server/storage/renderArchive";
import { PublicError } from "@/server/services/incidentService";

function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function manifestBytes(overrides: {
  contentId: string;
  storedOffset: number;
  storedSize: number;
  encoding?: "identity" | "zstd" | "zstd-dictionary";
  dictionary?: {
    contentId: string;
    size: number;
    storedOffset: number;
  } | null;
  extraResource?: boolean;
  extraFile?: boolean;
  ordinals?: number[];
  filePath?: string;
}): Uint8Array {
  const encoding = overrides.encoding ?? "identity";
  const suffix = encoding === "identity" ? "" : ".zst";
  const resourcePath = `objects/${overrides.contentId}${suffix}`;
  const items = (overrides.ordinals ?? [0]).map((ordinal) => ({
    id: `page-${ordinal}`,
    ordinal,
    width: 100,
    height: 100,
    document: overrides.contentId,
    dependencies: [] as string[],
  }));
  const resources = [
    {
      contentId: overrides.contentId,
      mime: "image/webp",
      encoding,
      rawSize: overrides.storedSize,
      storedSize: overrides.storedSize,
      storedOffset: overrides.storedOffset,
      path: resourcePath,
    },
  ];
  if (overrides.extraResource) {
    resources.push({
      contentId: "f".repeat(64),
      mime: "image/webp",
      encoding: "identity",
      rawSize: 1,
      storedSize: 1,
      storedOffset: 0,
      path: `objects/${"f".repeat(64)}`,
    });
  }
  const files = [{ path: overrides.filePath ?? "pages/0.webp", contentId: overrides.contentId }];
  if (overrides.extraFile) {
    files.push({ path: "pages/0.webp", contentId: overrides.contentId });
  }
  return Buffer.from(
    JSON.stringify({
      format: "classapp-render-archive",
      version: 1,
      dictionary: overrides.dictionary
        ? {
            contentId: overrides.dictionary.contentId,
            path: "dictionary.zdict",
            size: overrides.dictionary.size,
            storedOffset: overrides.dictionary.storedOffset,
          }
        : null,
      resources,
      files,
      document: {
        layout: "fixed",
        sourceMime: "application/pdf",
        sourcePages: items.length,
        firstPage: 1,
        lastPage: items.length,
        resolution: 144,
        webpQuality: 80,
        shared: [],
        items,
      },
    }),
  );
}

test("render archive entry names are the manifest, dictionary, or content-addressed objects", () => {
  const id = "a".repeat(64);
  assert.equal(isRenderArchiveEntryName("manifest.json"), true);
  assert.equal(isRenderArchiveEntryName("dictionary.zdict"), true);
  assert.equal(isRenderArchiveEntryName(`objects/${id}`), true);
  assert.equal(isRenderArchiveEntryName(`objects/${id}.zst`), true);
  assert.equal(isRenderArchiveEntryName(`objects/${id}.png`), false);
  assert.equal(isRenderArchiveEntryName("../manifest.json"), false);
  assert.equal(isRenderArchiveEntryName("objects/../secret"), false);
  assert.equal(isRenderArchiveEntryName("objects/gg"), false);
});

test("a consistent identity archive indexes resources and pages", () => {
  const payload = Buffer.from("page-one");
  const contentId = sha256(payload);
  const entries = [
    { name: "manifest.json", size: 12, originalSize: 12, compression: 0 },
    {
      name: `objects/${contentId}`,
      size: payload.byteLength,
      originalSize: payload.byteLength,
      compression: 0,
    },
  ];
  const indexed = validateRenderArchiveContents(
    manifestBytes({
      contentId,
      storedOffset: 40,
      storedSize: payload.byteLength,
    }),
    entries,
    200,
  );
  assert.equal(indexed.items.length, 1);
  assert.equal(indexed.resources.get(contentId)?.storedOffset, 40);
  assert.equal(indexed.header.item_count, 1);
});

test("orphan zip members, offset overruns, and path traversal fail closed", () => {
  const payload = Buffer.from("x");
  const contentId = sha256(payload);
  const objectEntry = {
    name: `objects/${contentId}`,
    size: 1,
    originalSize: 1,
    compression: 0,
  };
  const manifestEntry = {
    name: "manifest.json",
    size: 12,
    originalSize: 12,
    compression: 0,
  };

  assert.throws(
    () =>
      validateRenderArchiveContents(
        manifestBytes({ contentId, storedOffset: 0, storedSize: 1 }),
        [manifestEntry, objectEntry, { ...objectEntry, name: "objects/" + "b".repeat(64) }],
        100,
      ),
    PublicError,
  );

  assert.throws(
    () =>
      validateRenderArchiveContents(
        manifestBytes({ contentId, storedOffset: 99, storedSize: 2 }),
        [manifestEntry, objectEntry],
        100,
      ),
    PublicError,
  );

  assert.throws(
    () =>
      validateRenderArchiveContents(
        manifestBytes({
          contentId,
          storedOffset: 0,
          storedSize: 1,
          filePath: "../secret.webp",
        }),
        [manifestEntry, objectEntry],
        100,
      ),
    PublicError,
  );
});

test("page ordinals must be unique and dense from zero; dictionary encoding must agree", () => {
  const payload = Buffer.from("x");
  const contentId = sha256(payload);
  const entries = [
    { name: "manifest.json", size: 12, originalSize: 12, compression: 0 },
    { name: `objects/${contentId}.zst`, size: 1, originalSize: 1, compression: 0 },
  ];
  assert.throws(
    () =>
      validateRenderArchiveContents(
        manifestBytes({
          contentId,
          storedOffset: 0,
          storedSize: 1,
          encoding: "zstd-dictionary",
          ordinals: [0, 2],
        }),
        entries,
        100,
      ),
    PublicError,
  );
  assert.throws(
    () =>
      validateRenderArchiveContents(
        manifestBytes({
          contentId,
          storedOffset: 0,
          storedSize: 1,
          encoding: "zstd-dictionary",
          dictionary: null,
        }),
        entries,
        100,
      ),
    PublicError,
  );
});
