import type {
  BundleHeader,
  BundleItem,
  BundleResource,
  BundleSlice,
} from "@/shared/bundles/protocol";
import {
  BUNDLE_RESOURCE_LIMIT,
  BUNDLE_STREAM_MAGIC,
  BUNDLE_STREAM_VERSION,
  bundleSliceSchema,
} from "@/shared/bundles/protocol";
import { apiFetch, authHeaders } from "@/client/api/runtime";
import { extentFiles } from "@/client/data/files";
import { FileIds } from "@/client/data/fileIds";
import {
  BUNDLE_FRAME_SRC_DOC,
  secureBundlePageHtml,
  type BundleFrameLoadMessage,
  type BundleFrameResource,
} from "@/client/lib/bundleFrame";
import {
  reclaimAfterQuotaExceeded,
  recoverFromQuotaExceeded,
} from "@/client/interact/quota";
import { client } from "@/client/interact/remote/client";
import { session } from "@/client/interact/remote/session";
import { articleCapability } from "@/client/interact/capabilities";
import initZstd, {
  decompress,
  decompress_with_dictionary,
} from "@/lib/zstd-web/pkg/zstd_web.js";
import { captureDetachedClientIncident } from "@/client/interact/clientIncidents";

const { openArticleBundleAction, fetchArticleBundleItemsAction } =
  client.actions;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const MAX_RESOURCE_BATCH_BYTES = 128 * 1024 * 1024;

interface StoredBundleCatalog {
  header: BundleHeader;
  items: BundleItem[];
  resources: BundleResource[];
  exhausted_before: boolean;
  exhausted_after: boolean;
}

export interface MaterializedBundleItem {
  item: BundleItem;
  srcDoc: string;
  takeFramePayload(): {
    message: BundleFrameLoadMessage;
    transfer: ArrayBuffer[];
  } | null;
  release(): void;
}

let zstdReady: Promise<unknown> | null = null;
const articleResourceTails = new Map<string, Promise<void>>();
const articleCatalogTails = new Map<string, Promise<void>>();
const articlePrefetchTimers = new Map<string, ReturnType<typeof setTimeout>>();

function ensureZstd(): Promise<unknown> {
  return (zstdReady ??= initZstd());
}

function mergeCatalog(
  current: StoredBundleCatalog | null,
  slice: BundleSlice,
): StoredBundleCatalog {
  const items = new Map(current?.items.map((item) => [item.ordinal, item]));
  for (const item of slice.items) items.set(item.ordinal, item);
  const resources = new Map(
    current?.resources.map((resource) => [resource.content_id, resource]),
  );
  for (const resource of slice.resources) {
    resources.set(resource.content_id, resource);
  }
  return {
    header: slice.header,
    items: [...items.values()].sort(
      (left, right) => left.ordinal - right.ordinal,
    ),
    resources: [...resources.values()],
    exhausted_before: current?.exhausted_before || slice.exhausted_before,
    exhausted_after: current?.exhausted_after || slice.exhausted_after,
  };
}

async function readCatalog(
  articleId: string,
): Promise<StoredBundleCatalog | null> {
  const id = FileIds.articleBundleCatalog(articleId);
  const bytes = await extentFiles.readAll(id);
  if (!bytes) return null;
  try {
    const parsed = bundleSliceSchema.safeParse(
      JSON.parse(textDecoder.decode(bytes)),
    );
    if (parsed.success) return parsed.data;
    captureDetachedClientIncident(
      "bundle.catalog-contract",
      new Error("Stored Bundle catalog does not match its schema"),
    );
  } catch (error) {
    captureDetachedClientIncident("bundle.catalog-read", error);
  }
  // A concurrent publisher may already have replaced the corrupt generation;
  // leave cleanup to the next successful replace or quota collection.
  return null;
}

async function writeCatalog(
  articleId: string,
  catalog: StoredBundleCatalog,
): Promise<void> {
  const bytes = textEncoder.encode(JSON.stringify(catalog));
  await recoverFromQuotaExceeded(
    () =>
      extentFiles.replace(
        FileIds.articleBundleCatalog(articleId),
        bytes.byteLength,
        bytes.buffer,
      ),
    articleId,
  );
}

function localSlice(
  catalog: StoredBundleCatalog,
  start: number,
  end: number,
): BundleSlice {
  const items = catalog.items.filter(
    (item) => item.ordinal >= start && item.ordinal < end,
  );
  const ids = new Set(catalog.header.shared);
  if (catalog.header.dictionary) ids.add(catalog.header.dictionary.content_id);
  for (const item of items) {
    ids.add(item.document);
    for (const dependency of item.dependencies) ids.add(dependency);
  }
  return {
    header: catalog.header,
    items,
    resources: catalog.resources.filter((resource) =>
      ids.has(resource.content_id),
    ),
    exhausted_before: catalog.exhausted_before && start === 0,
    exhausted_after:
      catalog.exhausted_after && end >= catalog.header.item_count,
  };
}

class ResponseByteReader {
  private chunk: Uint8Array | null = null;
  private offset = 0;
  private released = false;

  constructor(
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
  ) {}

  async read(length: number): Promise<Uint8Array> {
    const output = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      if (!this.chunk || this.offset === this.chunk.byteLength) {
        const next = await this.reader.read();
        if (next.done) throw new Error("Bundle resource response ended early");
        this.chunk = next.value;
        this.offset = 0;
      }
      const amount = Math.min(
        length - written,
        this.chunk.byteLength - this.offset,
      );
      output.set(
        this.chunk.subarray(this.offset, this.offset + amount),
        written,
      );
      this.offset += amount;
      written += amount;
    }
    return output;
  }

  take(length: number): ReadableStream<Uint8Array> {
    let remaining = length;
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (!remaining) {
          controller.close();
          return;
        }
        const chunk = await this.read(Math.min(256 * 1024, remaining));
        remaining -= chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
  }

  async finish(): Promise<void> {
    try {
      if (this.chunk && this.offset !== this.chunk.byteLength) {
        throw new Error("Bundle resource response contained trailing data");
      }
      const next = await this.reader.read();
      if (!next.done)
        throw new Error("Bundle resource response contained trailing data");
    } finally {
      this.release();
    }
  }

  async cancel(reason: unknown): Promise<void> {
    if (this.released) return;
    try {
      await this.reader.cancel(reason);
    } catch (error) {
      // The network stream may already have failed or closed.
      captureDetachedClientIncident("bundle.stream-cancel", error);
    } finally {
      this.release();
    }
  }

  private release(): void {
    if (this.released) return;
    this.released = true;
    try {
      this.reader.releaseLock();
    } catch (error) {
      captureDetachedClientIncident("bundle.stream-release", error);
    }
  }
}

function hex(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
  return output;
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function withArticleTail<T>(
  tails: Map<string, Promise<void>>,
  articleId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = tails.get(articleId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  tails.set(articleId, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (tails.get(articleId) === tail) {
      tails.delete(articleId);
    }
  }
}

function withArticleResourceLock<T>(
  articleId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withArticleTail(articleResourceTails, articleId, operation);
}

function withArticleCatalogLock<T>(
  articleId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withArticleTail(articleCatalogTails, articleId, operation);
}

async function fetchResourceBatch(
  articleId: string,
  resources: BundleResource[],
): Promise<void> {
  const capability = articleCapability(articleId);
  const query = capability
    ? `?capability=${encodeURIComponent(capability)}`
    : "";
  const response = await apiFetch(
    `/api/articles/${encodeURIComponent(articleId)}/bundle/resources${query}`,
    {
      method: "POST",
      headers: {
        ...authHeaders(session.getToken()),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content_ids: resources.map((resource) => resource.content_id),
      }),
    },
  );
  if (!response.ok || !response.body) {
    throw new Error(`Bundle 资源下载失败 (${response.status})`);
  }
  const byteReader = new ResponseByteReader(response.body.getReader());
  try {
    const header = await byteReader.read(12);
    if (
      textDecoder.decode(header.subarray(0, 8)) !== BUNDLE_STREAM_MAGIC ||
      new DataView(header.buffer).getUint16(8, true) !==
        BUNDLE_STREAM_VERSION ||
      new DataView(header.buffer).getUint16(10, true) !== resources.length
    ) {
      throw new Error("Bundle 资源响应头无效");
    }
    for (const expected of resources) {
      const itemHeader = await byteReader.read(36);
      const contentId = hex(itemHeader.subarray(0, 32));
      const size = new DataView(itemHeader.buffer).getUint32(32, true);
      if (contentId !== expected.content_id || size !== expected.stored_size) {
        throw new Error("Bundle 资源响应顺序或大小无效");
      }
      // This stream is one-shot. Quota recovery happens by cancelling and
      // refetching the still-missing content IDs in ensureResources().
      await extentFiles.replace(
        FileIds.articleBundleResource(articleId, contentId),
        size,
        byteReader.take(size),
      );
    }
    await byteReader.finish();
  } catch (error) {
    await byteReader.cancel(error);
    throw error;
  }
}

async function ensureResources(
  articleId: string,
  resources: BundleResource[],
): Promise<void> {
  await withArticleResourceLock(articleId, async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const missing: BundleResource[] = [];
        for (const resource of resources) {
          const size = await extentFiles.size(
            FileIds.articleBundleResource(articleId, resource.content_id),
          );
          if (size !== resource.stored_size) missing.push(resource);
        }
        if (!missing.length) return;
        let batch: BundleResource[] = [];
        let bytes = 0;
        for (const resource of missing) {
          if (
            batch.length === BUNDLE_RESOURCE_LIMIT ||
            (batch.length > 0 &&
              bytes + resource.stored_size > MAX_RESOURCE_BATCH_BYTES)
          ) {
            await fetchResourceBatch(articleId, batch);
            batch = [];
            bytes = 0;
          }
          batch.push(resource);
          bytes += resource.stored_size;
        }
        if (batch.length) await fetchResourceBatch(articleId, batch);
      } catch (error) {
        if (await reclaimAfterQuotaExceeded(error, articleId)) continue;
        throw error;
      }
    }
    throw new Error("Bundle 资源无法完整保存在本机");
  });
}

function priorityResources(
  slice: BundleSlice,
  targetOrdinal: number,
): BundleResource[] {
  const item = slice.items.reduce<BundleItem | null>((closest, candidate) => {
    if (!closest) return candidate;
    return Math.abs(candidate.ordinal - targetOrdinal) <
      Math.abs(closest.ordinal - targetOrdinal)
      ? candidate
      : closest;
  }, null);
  const ids = new Set(slice.header.shared);
  if (slice.header.dictionary) ids.add(slice.header.dictionary.content_id);
  if (item) {
    ids.add(item.document);
    for (const dependency of item.dependencies) ids.add(dependency);
  }
  return slice.resources.filter((resource) => ids.has(resource.content_id));
}

function scheduleResourcePrefetch(
  articleId: string,
  resources: BundleResource[],
): void {
  const pending = articlePrefetchTimers.get(articleId);
  if (pending) clearTimeout(pending);
  articlePrefetchTimers.set(
    articleId,
    setTimeout(() => {
      articlePrefetchTimers.delete(articleId);
      void ensureResources(articleId, resources).catch((error) =>
        captureDetachedClientIncident("bundle.resource-prefetch", error),
      );
    }, 0),
  );
}

async function acceptSlice(
  articleId: string,
  slice: BundleSlice,
  targetOrdinal: number,
): Promise<BundleSlice> {
  await withArticleCatalogLock(articleId, async () => {
    const catalog = mergeCatalog(await readCatalog(articleId), slice);
    await ensureResources(articleId, priorityResources(slice, targetOrdinal));
    await writeCatalog(articleId, catalog);
  });
  scheduleResourcePrefetch(articleId, slice.resources);
  return slice;
}

export async function openArticleBundle(
  articleId: string,
  cursor: number,
): Promise<BundleSlice | null> {
  if (!client.isConnected()) {
    const catalog = await readCatalog(articleId);
    if (!catalog) return null;
    return localSlice(
      catalog,
      Math.max(0, cursor - 4),
      Math.min(catalog.header.item_count, cursor + 7),
    );
  }
  const result = await openArticleBundleAction({
    articleId,
    cursor,
    before: 4,
    after: 6,
  });
  if (!result.ok) return null;
  return acceptSlice(articleId, result.data, cursor);
}

export async function fetchArticleBundleItems(
  articleId: string,
  cursor: number,
  direction: "before" | "after",
): Promise<BundleSlice | null> {
  if (!client.isConnected()) {
    const catalog = await readCatalog(articleId);
    if (!catalog) return null;
    return direction === "before"
      ? localSlice(catalog, Math.max(0, cursor - 12), cursor)
      : localSlice(
          catalog,
          cursor + 1,
          Math.min(catalog.header.item_count, cursor + 13),
        );
  }
  const result = await fetchArticleBundleItemsAction({
    articleId,
    cursor,
    direction,
    limit: 12,
  });
  if (!result.ok) return null;
  return acceptSlice(
    articleId,
    result.data,
    direction === "before" ? cursor - 1 : cursor + 1,
  );
}

async function resourceBytes(
  articleId: string,
  resource: BundleResource,
  dictionary: Uint8Array | null,
): Promise<Uint8Array> {
  const fileId = FileIds.articleBundleResource(articleId, resource.content_id);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const stored = new Uint8Array(
        await extentFiles.read(fileId, 0, resource.stored_size),
      );
      let raw: Uint8Array;
      if (resource.encoding === "identity") {
        raw = stored;
      } else {
        await ensureZstd();
        if (resource.encoding === "zstd-dictionary" && !dictionary) {
          throw new Error("Bundle 缺少 Zstd 字典");
        }
        raw =
          resource.encoding === "zstd-dictionary"
            ? decompress_with_dictionary(stored, dictionary!, resource.raw_size)
            : decompress(stored, resource.raw_size);
      }
      const digest = hex(
        new Uint8Array(await crypto.subtle.digest("SHA-256", ownedBuffer(raw))),
      );
      if (digest !== resource.content_id) {
        throw new Error("Bundle 资源校验失败");
      }
      return raw;
    } catch (error) {
      await extentFiles.delete(fileId);
      if (attempt === 0 && client.isConnected()) {
        await ensureResources(articleId, [resource]);
        continue;
      }
      throw error;
    }
  }
  throw new Error("Bundle 资源不可用");
}

/**
 * Verify and decompress one page, then transfer its dependencies into an
 * opaque frame. Object URLs are deliberately created inside that frame.
 */
export async function materializeBundleItem(
  articleId: string,
  item: BundleItem,
): Promise<MaterializedBundleItem> {
  const catalog = await readCatalog(articleId);
  if (!catalog) throw new Error("Bundle 尚未保存在本机");
  const resources = new Map(
    catalog.resources.map((resource) => [resource.content_id, resource]),
  );
  const dictionaryResource = catalog.header.dictionary;
  const dictionary = dictionaryResource
    ? await resourceBytes(articleId, dictionaryResource, null)
    : null;
  const frameResources: BundleFrameResource[] = [];
  try {
    for (const contentId of new Set([
      ...catalog.header.shared,
      ...item.dependencies,
    ])) {
      const resource = resources.get(contentId);
      if (!resource) throw new Error(`Bundle 资源目录缺少 ${contentId}`);
      const raw = await resourceBytes(articleId, resource, dictionary);
      frameResources.push({
        content_id: contentId,
        mime: resource.mime,
        bytes: ownedBuffer(raw),
      });
    }
    const documentResource = resources.get(item.document);
    if (!documentResource) throw new Error("Bundle 页面文档不存在");
    const documentBytes = await resourceBytes(
      articleId,
      documentResource,
      dictionary,
    );
    const html = secureBundlePageHtml(
      textDecoder.decode(documentBytes),
      new Map(
        frameResources.map((resource) => [
          resource.content_id,
          { mime: resource.mime },
        ]),
      ),
    );
    let payload: BundleFrameLoadMessage | null = {
      type: "classapp:bundle-frame-load",
      html,
      resources: frameResources,
    };
    return {
      item,
      srcDoc: BUNDLE_FRAME_SRC_DOC,
      takeFramePayload() {
        if (!payload) return null;
        const current = payload;
        payload = null;
        return {
          message: current,
          transfer: current.resources.map((resource) => resource.bytes),
        };
      },
      release() {
        payload = null;
        frameResources.length = 0;
      },
    };
  } catch (error) {
    frameResources.length = 0;
    throw error;
  }
}

export async function downloadBundleForOffline(
  articleId: string,
  onProgress?: (percent: number) => void,
): Promise<number> {
  let slice = await openArticleBundle(articleId, 0);
  if (!slice) throw new Error("无法打开 Bundle");
  onProgress?.(0);
  while (!slice.exhausted_after) {
    const last = slice.items.at(-1);
    if (!last) break;
    slice = await fetchArticleBundleItems(articleId, last.ordinal, "after");
    if (!slice) throw new Error("无法继续下载 Bundle");
    onProgress?.(
      Math.round(
        (((slice.items.at(-1)?.ordinal ?? last.ordinal) + 1) /
          Math.max(1, slice.header.item_count)) *
          100,
      ),
    );
  }
  const catalog = await readCatalog(articleId);
  if (
    !catalog ||
    !catalog.exhausted_before ||
    !catalog.exhausted_after ||
    catalog.items.length !== catalog.header.item_count ||
    catalog.items.some((item, ordinal) => item.ordinal !== ordinal)
  ) {
    throw new Error("Bundle 页面目录下载不完整");
  }
  await ensureResources(articleId, catalog.resources);
  onProgress?.(100);
  return (
    await extentFiles.list(FileIds.articleBundlePrefix(articleId))
  ).reduce((sum, file) => sum + file.size, 0);
}

export async function purgeArticleBundle(articleId: string): Promise<void> {
  const pending = articlePrefetchTimers.get(articleId);
  if (pending) clearTimeout(pending);
  articlePrefetchTimers.delete(articleId);
  await withArticleCatalogLock(articleId, () =>
    withArticleResourceLock(articleId, () =>
      extentFiles.deletePrefix(FileIds.articlePrefix(articleId)),
    ),
  );
}

export async function bundleAvailable(
  articleId: string,
  ordinal: number,
): Promise<boolean> {
  const catalog = await readCatalog(articleId);
  const item = catalog?.items.find(
    (candidate) => candidate.ordinal === ordinal,
  );
  if (!catalog || !item) return false;
  const resources = new Map(
    catalog.resources.map((resource) => [resource.content_id, resource]),
  );
  const ids = new Set([
    ...catalog.header.shared,
    ...item.dependencies,
    item.document,
  ]);
  if (catalog.header.dictionary) ids.add(catalog.header.dictionary.content_id);
  for (const id of ids) {
    const resource = resources.get(id);
    if (!resource) return false;
    const size = await extentFiles.size(
      FileIds.articleBundleResource(articleId, id),
    );
    if (size !== resource.stored_size) return false;
  }
  return true;
}
