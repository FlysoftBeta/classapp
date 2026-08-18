import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { Unzip } from "fflate";
import { z } from "zod";
import type {
  BundleHeader,
  BundleItem,
  BundleResource,
} from "@/shared/bundles/protocol";
import type { BlobStore } from "./blobStore";
import { PublicError } from "@/server/services/incidentService";

const MANIFEST_NAME = "manifest.json";
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 200_000;
const MAX_RESOURCE_BYTES = 512 * 1024 * 1024;

const contentId = z.string().regex(/^[0-9a-f]{64}$/);
const archiveResourceSchema = z
  .object({
    contentId,
    mime: z.string().min(1).max(255),
    encoding: z.enum(["identity", "zstd", "zstd-dictionary"]),
    rawSize: z.number().int().nonnegative().max(MAX_RESOURCE_BYTES),
    storedSize: z.number().int().nonnegative().max(MAX_RESOURCE_BYTES),
    storedOffset: z.number().int().nonnegative(),
    path: z.string().min(1),
  })
  .strict();
const archiveDictionarySchema = z
  .object({
    contentId,
    path: z.literal("dictionary.zdict"),
    size: z
      .number()
      .int()
      .positive()
      .max(1024 * 1024),
    storedOffset: z.number().int().nonnegative(),
  })
  .strict();
const archiveItemSchema = z
  .object({
    id: z.string().min(1).max(255),
    ordinal: z.number().int().nonnegative(),
    width: z.number().positive(),
    height: z.number().positive(),
    document: contentId,
    dependencies: z.array(contentId).max(4096),
  })
  .strict();
const renderArchiveManifestSchema = z
  .object({
    format: z.literal("classapp-render-archive"),
    version: z.literal(1),
    dictionary: archiveDictionarySchema.nullable(),
    resources: z.array(archiveResourceSchema).max(MAX_ARCHIVE_ENTRIES),
    files: z
      .array(z.object({ path: z.string().min(1), contentId }).strict())
      .max(MAX_ARCHIVE_ENTRIES),
    document: z
      .object({
        layout: z.literal("fixed"),
        sourceMime: z.string().min(1).max(255),
        sourcePages: z.number().int().positive(),
        firstPage: z.number().int().positive(),
        lastPage: z.number().int().positive(),
        resolution: z.number().positive(),
        webpQuality: z.number().int().min(0).max(100),
        shared: z.array(contentId).max(4096),
        items: z.array(archiveItemSchema).max(MAX_ARCHIVE_ENTRIES),
      })
      .strict(),
  })
  .strict();

type ArchiveManifest = z.infer<typeof renderArchiveManifestSchema>;
type ArchiveResource = z.infer<typeof archiveResourceSchema>;

export interface RenderArchiveIndex {
  archiveSize: number;
  header: BundleHeader;
  items: BundleItem[];
  resources: ReadonlyMap<string, IndexedArchiveResource>;
}

export interface IndexedArchiveResource extends BundleResource {
  storedOffset: number;
}

export interface StoredRenderArchive extends RenderArchiveIndex {
  stream(range?: { start: number; end: number }): Promise<ReadableStream<Uint8Array>>;
}

interface ZipEntrySummary {
  name: string;
  size: number;
  originalSize: number;
  compression: number;
}

const indexCache = new Map<string, Promise<StoredRenderArchive>>();

function validEntryName(name: string): boolean {
  return (
    name === MANIFEST_NAME ||
    name === "dictionary.zdict" ||
    /^objects\/[0-9a-f]{64}(?:\.zst)?$/.test(name)
  );
}

async function extractManifest(
  chunks: AsyncIterable<Uint8Array>,
): Promise<{ manifestBytes: Uint8Array; entries: ZipEntrySummary[] }> {
  const entries: ZipEntrySummary[] = [];
  const names = new Set<string>();
  const manifestChunks: Uint8Array[] = [];
  let manifestSize = 0;
  let manifestComplete = false;

  const archive = new Unzip((file) => {
    if (entries.length >= MAX_ARCHIVE_ENTRIES + 2) {
      throw new PublicError("渲染归档包含过多条目");
    }
    if (!validEntryName(file.name) || names.has(file.name)) {
      throw new PublicError("渲染归档包含无效条目");
    }
    if (file.size === undefined || file.originalSize === undefined) {
      throw new PublicError("渲染归档不允许数据描述符");
    }
    names.add(file.name);
    entries.push({
      name: file.name,
      size: file.size,
      originalSize: file.originalSize,
      compression: file.compression,
    });
    if (file.compression !== 0) {
      throw new PublicError("渲染归档必须使用 STORED ZIP 条目");
    }
    if (file.name === MANIFEST_NAME && file.originalSize > MAX_MANIFEST_BYTES) {
      throw new PublicError("渲染归档索引过大");
    }
    file.ondata = (error, data, final) => {
      if (error) throw new PublicError("渲染归档无法读取");
      if (file.name === MANIFEST_NAME && data?.length) {
        manifestSize += data.length;
        if (manifestSize > MAX_MANIFEST_BYTES) {
          throw new PublicError("渲染归档索引过大");
        }
        manifestChunks.push(data.slice());
      }
      if (file.name === MANIFEST_NAME && final) manifestComplete = true;
    };
    // Starting every entry prevents fflate from buffering ignored payloads.
    file.start();
  });

  try {
    for await (const chunk of chunks) {
      archive.push(
        new Uint8Array(
          (chunk as Uint8Array).buffer,
          (chunk as Uint8Array).byteOffset,
          (chunk as Uint8Array).byteLength,
        ),
        false,
      );
    }
    archive.push(new Uint8Array(), true);
  } catch (error) {
    if (error instanceof PublicError) throw error;
    throw new PublicError(
      "渲染归档无法读取",
      "Render archive read failed",
      error,
    );
  }
  if (!manifestComplete) throw new PublicError("渲染归档缺少 manifest");
  const manifestBytes = new Uint8Array(manifestSize);
  let offset = 0;
  for (const chunk of manifestChunks) {
    manifestBytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { manifestBytes, entries };
}

function parseManifest(bytes: Uint8Array): ArchiveManifest {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new PublicError("渲染归档 manifest 无效");
  }
  const parsed = renderArchiveManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new PublicError("渲染归档 manifest 格式不受支持");
  }
  return parsed.data;
}

function publicResource(resource: ArchiveResource): BundleResource {
  return {
    content_id: resource.contentId,
    mime: resource.mime,
    encoding: resource.encoding,
    raw_size: resource.rawSize,
    stored_size: resource.storedSize,
  };
}

function validateManifest(
  manifest: ArchiveManifest,
  entries: ZipEntrySummary[],
  archiveSize: number,
): Omit<RenderArchiveIndex, "archiveSize"> {
  const zipEntries = new Map(entries.map((entry) => [entry.name, entry]));
  const resources = new Map<string, IndexedArchiveResource>();
  const paths = new Set<string>();
  const expectedEntryCount =
    manifest.resources.length + 1 + (manifest.dictionary ? 1 : 0);
  if (zipEntries.size !== expectedEntryCount) {
    throw new PublicError("渲染归档条目与 manifest 不一致");
  }

  for (const resource of manifest.resources) {
    const entry = zipEntries.get(resource.path);
    if (
      resources.has(resource.contentId) ||
      paths.has(resource.path) ||
      !entry ||
      entry.size !== resource.storedSize ||
      entry.originalSize !== resource.storedSize ||
      resource.storedOffset + resource.storedSize > archiveSize
    ) {
      throw new PublicError("渲染归档资源索引不一致");
    }
    const suffix = resource.encoding === "identity" ? "" : ".zst";
    if (resource.path !== `objects/${resource.contentId}${suffix}`) {
      throw new PublicError("渲染归档资源路径无效");
    }
    paths.add(resource.path);
    resources.set(resource.contentId, {
      ...publicResource(resource),
      storedOffset: resource.storedOffset,
    });
  }

  let dictionary: BundleResource | null = null;
  if (manifest.dictionary) {
    const source = manifest.dictionary;
    const entry = zipEntries.get(source.path);
    if (
      !entry ||
      entry.size !== source.size ||
      source.storedOffset + source.size > archiveSize ||
      resources.has(source.contentId)
    ) {
      throw new PublicError("渲染归档字典索引不一致");
    }
    dictionary = {
      content_id: source.contentId,
      mime: "application/zstd-dictionary",
      encoding: "identity",
      raw_size: source.size,
      stored_size: source.size,
    };
    resources.set(source.contentId, {
      ...dictionary,
      storedOffset: source.storedOffset,
    });
  }

  const referenced = new Set<string>(manifest.document.shared);
  for (const item of manifest.document.items) {
    referenced.add(item.document);
    for (const dependency of item.dependencies) referenced.add(dependency);
  }
  for (const id of referenced) {
    if (!resources.has(id)) {
      throw new PublicError("渲染归档引用了不存在的资源");
    }
  }
  const ordinals = new Set<number>();
  const itemIds = new Set<string>();
  for (const item of manifest.document.items) {
    if (ordinals.has(item.ordinal) || itemIds.has(item.id)) {
      throw new PublicError("渲染归档包含重复页面");
    }
    ordinals.add(item.ordinal);
    itemIds.add(item.id);
  }
  const items = [...manifest.document.items].sort(
    (left, right) => left.ordinal - right.ordinal,
  );
  if (items.some((item, index) => item.ordinal !== index)) {
    throw new PublicError("渲染归档页面序号不连续");
  }
  if (
    manifest.dictionary === null &&
    manifest.resources.some(
      (resource) => resource.encoding === "zstd-dictionary",
    )
  ) {
    throw new PublicError("渲染归档缺少 Zstd 字典");
  }
  if (
    manifest.dictionary !== null &&
    manifest.resources.some(
      (resource) =>
        resource.encoding !== "identity" &&
        resource.encoding !== "zstd-dictionary",
    )
  ) {
    throw new PublicError("渲染归档的 Zstd 编码不一致");
  }

  const filePaths = new Set<string>();
  for (const file of manifest.files) {
    if (
      !resources.has(file.contentId) ||
      filePaths.has(file.path) ||
      file.path.split("/").includes("..") ||
      file.path.includes("\\") ||
      file.path.startsWith("/")
    ) {
      throw new PublicError("渲染归档文件表无效");
    }
    filePaths.add(file.path);
  }

  return {
    header: {
      protocol_version: 1,
      layout: "fixed",
      source_mime: manifest.document.sourceMime,
      item_count: items.length,
      dictionary,
      shared: manifest.document.shared,
    },
    items: items.map((item) => ({
      id: item.id,
      ordinal: item.ordinal,
      width: item.width,
      height: item.height,
      document: item.document,
      dependencies: item.dependencies,
    })),
    resources,
  };
}

/**
 * Validate a renderer-produced archive on a local temporary path before it is
 * published through BlobStore.
 */
export async function inspectRenderArchiveFile(
  absolutePath: string,
): Promise<RenderArchiveIndex> {
  const [info, { manifestBytes, entries }] = await Promise.all([
    stat(absolutePath),
    extractManifest(createReadStream(absolutePath)),
  ]);
  const manifest = parseManifest(manifestBytes);
  return {
    archiveSize: info.size,
    ...validateManifest(manifest, entries, info.size),
  };
}

/**
 * Index a published archive through BlobStore. The immutable offset index
 * keeps the hot path streaming selected STORED payloads only.
 */
export function loadRenderArchive(
  blobs: BlobStore,
  blobId: string,
): Promise<StoredRenderArchive> {
  let pending = indexCache.get(blobId);
  if (!pending) {
    pending = (async () => {
      const open = await blobs.open(blobId);
      const { manifestBytes, entries } = await extractManifest(
        Readable.fromWeb(open.body as never) as AsyncIterable<Uint8Array>,
      );
      const manifest = parseManifest(manifestBytes);
      return {
        archiveSize: open.size,
        ...validateManifest(manifest, entries, open.size),
        stream: (range: { start: number; end: number } | undefined) =>
          blobs.open(blobId, range).then((value) => value.body),
      };
    })().catch((error) => {
      indexCache.delete(blobId);
      throw error;
    });
    indexCache.set(blobId, pending);
  }
  return pending;
}

export function forgetRenderArchive(blobId: string): void {
  indexCache.delete(blobId);
}

export function streamArchiveResource(
  archive: StoredRenderArchive,
  resource: IndexedArchiveResource,
): Promise<ReadableStream<Uint8Array>> {
  if (!resource.stored_size) {
    return Promise.resolve(
      new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
    );
  }
  const end = resource.storedOffset + resource.stored_size - 1;
  return archive.stream({ start: resource.storedOffset, end });
}
