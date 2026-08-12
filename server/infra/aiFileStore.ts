import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { unzipSync, zipSync } from "fflate";
import { z } from "zod";
import { DATA_ROOT } from "@/server/infra/env";
import { PublicError } from "@/server/services/incidentService";
import type { AiAttachment } from "@/shared/types/api";

const MAX_STORE_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 256;
const CATALOG_NAME = "catalog.json";

const catalogEntrySchema = z
  .object({
    id: z.string().uuid(),
    path: z.string(),
    mime: z.string(),
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    updatedAt: z.string(),
  })
  .strict();
const catalogSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().nonnegative(),
    entries: z.array(catalogEntrySchema).max(MAX_FILES),
  })
  .strict();

type Catalog = z.infer<typeof catalogSchema>;
type CatalogEntry = z.infer<typeof catalogEntrySchema>;
type Archive = Record<string, Uint8Array>;

const locks = new Map<string, Promise<void>>();

function archivePath(userId: string): string {
  const identity = crypto.createHash("sha256").update(userId).digest("hex");
  return path.join(DATA_ROOT, "blobs", "ai", `${identity}.zip`);
}

function archiveLogicalPath(value: string): string {
  const normalized = path.posix.normalize(value.trim().replaceAll("\\", "/"));
  const parts = normalized.split("/");
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized) ||
    /^[A-Za-z]:/.test(normalized) ||
    parts.length > 3 ||
    parts.some((part) => !part || part === "." || part.startsWith("."))
  ) {
    throw new PublicError("文件路径无效；请使用不超过两级目录的相对路径");
  }
  const extension = path.posix.extname(normalized).toLowerCase();
  if (
    ![".txt", ".md", ".svg", ".png", ".jpg", ".webp", ".gif"].includes(
      extension,
    )
  ) {
    throw new PublicError("文件类型不受支持");
  }
  return normalized;
}

function logicalPath(value: string): string {
  const normalized = archiveLogicalPath(value);
  const extension = path.posix.extname(normalized).toLowerCase();
  if (![".txt", ".md", ".svg"].includes(extension)) {
    throw new PublicError("只支持 txt、md 和 svg 文件");
  }
  return normalized;
}

function mimeFor(filePath: string): string {
  const extension = path.posix.extname(filePath).toLowerCase();
  if (extension === ".md") return "text/markdown";
  if (extension === ".svg") return "image/svg+xml";
  return "text/plain";
}

function assertSafeTextContent(filePath: string, content: string): void {
  if (content.includes("\0")) throw new PublicError("文件内容包含无效字符");
  if (path.posix.extname(filePath).toLowerCase() !== ".svg") return;
  if (
    /<\s*(?:script|foreignObject)\b/i.test(content) ||
    /\son[a-z]+\s*=/i.test(content) ||
    /(?:href|src)\s*=\s*["']\s*(?:javascript:|https?:|\/\/)/i.test(content) ||
    /<!ENTITY\b/i.test(content)
  ) {
    throw new PublicError("SVG 包含脚本、事件处理器或外部资源");
  }
}

function objectName(id: string): string {
  return `objects/${id}`;
}

function emptyArchive(): { catalog: Catalog; files: Archive } {
  return { catalog: { version: 1, revision: 0, entries: [] }, files: {} };
}

function loadArchive(userId: string): { catalog: Catalog; files: Archive } {
  const target = archivePath(userId);
  if (!fs.existsSync(target)) return emptyArchive();
  let files: Archive;
  try {
    files = unzipSync(new Uint8Array(fs.readFileSync(target)));
  } catch (error) {
    throw new PublicError("AI 文件存储损坏", "AI ZIP extraction failed", error);
  }
  const bytes = files[CATALOG_NAME];
  if (!bytes) throw new PublicError("AI 文件存储缺少 catalog.json");
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    throw new PublicError("AI 文件目录损坏", "AI catalog JSON failed", error);
  }
  const parsed = catalogSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PublicError(
      "AI 文件目录损坏",
      "AI catalog contract failed",
      parsed.error.issues,
    );
  }
  const seenPaths = new Set<string>();
  for (const entry of parsed.data.entries) {
    const normalized = archiveLogicalPath(entry.path);
    if (normalized !== entry.path || seenPaths.has(normalized)) {
      throw new PublicError("AI 文件目录包含无效或重复路径");
    }
    seenPaths.add(normalized);
    const content = files[objectName(entry.id)];
    if (!content || content.byteLength !== entry.size) {
      throw new PublicError("AI 文件目录与归档内容不一致");
    }
  }
  return { catalog: parsed.data, files };
}

function publishArchive(
  userId: string,
  catalog: Catalog,
  files: Archive,
): void {
  const target = archivePath(userId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const encodedCatalog = Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`);
  const retained: Archive = { [CATALOG_NAME]: encodedCatalog };
  for (const entry of catalog.entries) {
    retained[objectName(entry.id)] = files[objectName(entry.id)]!;
  }
  const encoded = zipSync(retained, { level: 6 });
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${crypto.randomUUID()}.pending`,
  );
  const handle = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(handle, encoded);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  try {
    fs.renameSync(temporary, target);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function totalBytes(entries: CatalogEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.size, 0);
}

async function exclusive<T>(userId: string, operation: () => T): Promise<T> {
  const previous = locks.get(userId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  locks.set(userId, queued);
  await previous;
  try {
    return operation();
  } finally {
    release();
    if (locks.get(userId) === queued) locks.delete(userId);
  }
}

function publicEntry(entry: CatalogEntry) {
  return {
    path: entry.path,
    mime: entry.mime,
    size: entry.size,
    updated_at: entry.updatedAt,
  };
}

export async function inspectAiFileStore(userId: string) {
  return exclusive(userId, () => {
    const { catalog } = loadArchive(userId);
    return {
      revision: catalog.revision,
      totalBytes: totalBytes(catalog.entries),
      files: catalog.entries
        .map(publicEntry)
        .sort((a, b) => a.path.localeCompare(b.path)),
    };
  });
}

export async function readAiFile(userId: string, requestedPath: string) {
  return exclusive(userId, () => {
    const filePath = logicalPath(requestedPath);
    const { catalog, files } = loadArchive(userId);
    const entry = catalog.entries.find((item) => item.path === filePath);
    if (!entry) throw new PublicError("文件不存在");
    return {
      ...publicEntry(entry),
      content: Buffer.from(files[objectName(entry.id)]!).toString("utf8"),
      revision: catalog.revision,
    };
  });
}

export async function mutateAiFileStore(
  userId: string,
  mutation:
    | { kind: "create"; path: string; content: string }
    | {
        kind: "replace";
        path: string;
        oldText: string;
        newText: string;
        expectedReplacements: number;
      }
    | { kind: "delete"; path: string },
) {
  return exclusive(userId, () => {
    const filePath = logicalPath(mutation.path);
    const { catalog, files } = loadArchive(userId);
    const index = catalog.entries.findIndex((entry) => entry.path === filePath);
    let content: string | null = null;
    let entry: CatalogEntry | null =
      index >= 0 ? catalog.entries[index]! : null;
    if (mutation.kind === "create") {
      if (entry) throw new PublicError("文件已存在，请使用局部修改工具");
      content = mutation.content;
      entry = {
        id: crypto.randomUUID(),
        path: filePath,
        mime: mimeFor(filePath),
        size: 0,
        sha256: "",
        updatedAt: "",
      };
      catalog.entries.push(entry);
    } else if (mutation.kind === "delete") {
      if (!entry) throw new PublicError("文件不存在");
      catalog.entries.splice(index, 1);
      delete files[objectName(entry.id)];
    } else {
      if (!entry) throw new PublicError("文件不存在");
      const previous = Buffer.from(files[objectName(entry.id)]!).toString(
        "utf8",
      );
      if (!mutation.oldText) throw new PublicError("oldText 不能为空");
      const occurrences = previous.split(mutation.oldText).length - 1;
      if (occurrences !== mutation.expectedReplacements) {
        throw new PublicError(
          `待替换文本出现 ${occurrences} 次，与期望的 ${mutation.expectedReplacements} 次不一致`,
        );
      }
      content = previous.split(mutation.oldText).join(mutation.newText);
    }
    if (content !== null && entry) {
      assertSafeTextContent(filePath, content);
      const bytes = Buffer.from(content, "utf8");
      entry.size = bytes.byteLength;
      entry.sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      entry.updatedAt = new Date().toISOString();
      files[objectName(entry.id)] = bytes;
    }
    if (
      mutation.kind !== "delete" &&
      totalBytes(catalog.entries) > MAX_STORE_BYTES
    ) {
      throw new PublicError("AI 文件总大小不能超过 10 MB");
    }
    if (catalog.entries.length > MAX_FILES) {
      throw new PublicError(`AI 文件数量不能超过 ${MAX_FILES}`);
    }
    catalog.revision += 1;
    publishArchive(userId, catalog, files);
    return {
      revision: catalog.revision,
      totalBytes: totalBytes(catalog.entries),
      file: entry ? publicEntry(entry) : null,
      deleted: mutation.kind === "delete" ? filePath : null,
    };
  });
}

const ATTACHMENT_EXTENSIONS = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
} as const;

function attachmentMagicMatches(
  mime: keyof typeof ATTACHMENT_EXTENSIONS,
  bytes: Uint8Array,
): boolean {
  const header = Buffer.from(bytes.subarray(0, 12));
  if (mime === "image/png")
    return header.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  if (mime === "image/jpeg")
    return header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  if (mime === "image/gif")
    return header.subarray(0, 4).toString("ascii") === "GIF8";
  return (
    header.subarray(0, 4).toString("ascii") === "RIFF" &&
    header.subarray(8, 12).toString("ascii") === "WEBP"
  );
}

function attachmentLogicalPath(
  name: string,
  extension: string,
  existing: Set<string>,
): string {
  const base =
    path.posix
      .basename(name, path.posix.extname(name))
      .normalize("NFKC")
      .replace(/[^\p{L}\p{N}_-]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "image";
  let candidate = `attachments/${base}${extension}`;
  let suffix = 2;
  while (existing.has(candidate)) {
    candidate = `attachments/${base}-${suffix}${extension}`;
    suffix += 1;
  }
  return candidate;
}

export async function storeAiAttachments(
  userId: string,
  inputs: Array<{
    name: string;
    mime: keyof typeof ATTACHMENT_EXTENSIONS;
    bytes: Uint8Array;
  }>,
): Promise<AiAttachment[]> {
  return exclusive(userId, () => {
    const { catalog, files } = loadArchive(userId);
    const attachments: AiAttachment[] = [];
    const existingPaths = new Set(catalog.entries.map((entry) => entry.path));
    for (const input of inputs) {
      if (!input.bytes.byteLength) throw new PublicError("图片内容为空");
      if (!attachmentMagicMatches(input.mime, input.bytes)) {
        throw new PublicError(`${input.name} 的图片格式与声明类型不一致`);
      }
      const id = crypto.randomUUID();
      const attachmentPath = attachmentLogicalPath(
        input.name,
        ATTACHMENT_EXTENSIONS[input.mime],
        existingPaths,
      );
      existingPaths.add(attachmentPath);
      const updatedAt = new Date().toISOString();
      const entry: CatalogEntry = {
        id,
        path: attachmentPath,
        mime: input.mime,
        size: input.bytes.byteLength,
        sha256: crypto.createHash("sha256").update(input.bytes).digest("hex"),
        updatedAt,
      };
      catalog.entries.push(entry);
      files[objectName(id)] = input.bytes;
      attachments.push({
        path: attachmentPath,
        name: input.name.slice(0, 200),
        mime: input.mime,
        size: input.bytes.byteLength,
      });
    }
    if (catalog.entries.length > MAX_FILES) {
      throw new PublicError(`AI 文件数量不能超过 ${MAX_FILES}`);
    }
    if (totalBytes(catalog.entries) > MAX_STORE_BYTES) {
      throw new PublicError("AI 文件总大小不能超过 10 MB");
    }
    catalog.revision += 1;
    publishArchive(userId, catalog, files);
    return attachments;
  });
}

export async function readAiAttachmentDataUrl(
  userId: string,
  attachment: AiAttachment,
): Promise<string> {
  return exclusive(userId, () => {
    const requestedPath = archiveLogicalPath(attachment.path);
    if (!requestedPath.startsWith("attachments/")) {
      throw new PublicError("图片附件路径无效");
    }
    const { catalog, files } = loadArchive(userId);
    const entry = catalog.entries.find((item) => item.path === requestedPath);
    if (!entry || entry.mime !== attachment.mime) {
      throw new PublicError("图片附件不存在");
    }
    return `data:${entry.mime};base64,${Buffer.from(files[objectName(entry.id)]!).toString("base64")}`;
  });
}

export async function deleteAiAttachments(
  userId: string,
  requestedPaths: string[],
): Promise<void> {
  if (!requestedPaths.length) return;
  await exclusive(userId, () => {
    const paths = new Set(requestedPaths.map(archiveLogicalPath));
    const { catalog, files } = loadArchive(userId);
    const removed = catalog.entries.filter((entry) => paths.has(entry.path));
    if (!removed.length) return;
    catalog.entries = catalog.entries.filter((entry) => !paths.has(entry.path));
    for (const entry of removed) delete files[objectName(entry.id)];
    catalog.revision += 1;
    publishArchive(userId, catalog, files);
  });
}

export async function removeAiFileStore(userId: string): Promise<void> {
  await exclusive(userId, () => {
    fs.rmSync(archivePath(userId), { force: true });
  });
}
