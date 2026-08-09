import crypto from "crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, unlink, writeFile } from "fs/promises";
import { Readable } from "node:stream";
import path from "path";
import { bytes, formatBytes } from "@/shared/bytes";
import { ServiceError } from "@/server/services/errors";

const BLOB_ROOT = path.join(process.cwd(), "blobs");
const ARTICLE_BLOB_DIR = "articles";
const MAX_BLOB_BYTES = bytes("200 MB");

export interface StoredArticleBlob {
  relativePath: string;
  absolutePath: string;
  mimeType: "application/pdf";
  fileSize: number;
  originalFilename: string;
}

function normalizeArticleMime(file: File): StoredArticleBlob["mimeType"] {
  const name = file.name.toLowerCase();
  if (file.type === "application/pdf" || name.endsWith(".pdf")) {
    return "application/pdf";
  }
  throw new ServiceError("仅支持 PDF 文件");
}

export async function storeArticleBlob(file: File): Promise<StoredArticleBlob> {
  if (!file.size) throw new ServiceError("文件不能为空");
  if (file.size > MAX_BLOB_BYTES) {
    throw new ServiceError(`文件不能超过 ${formatBytes(MAX_BLOB_BYTES)}`);
  }
  const mimeType = normalizeArticleMime(file);
  const filename = `${crypto.randomUUID()}.pdf`;
  // Persist platform-independent paths because the database and blob directory
  // can move between Windows and POSIX hosts.
  const relativePath = path.posix.join(ARTICLE_BLOB_DIR, filename);
  const absolutePath = path.join(BLOB_ROOT, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, Buffer.from(await file.arrayBuffer()), {
    flag: "wx",
  });
  return {
    relativePath,
    absolutePath,
    mimeType,
    fileSize: file.size,
    originalFilename: file.name || filename,
  };
}

export function resolveArticleBlobPath(relativePath: string): string {
  // Treat both separators as path separators so blobs written on Windows can
  // still be resolved after moving the data directory to Linux (and vice versa).
  const portablePath = relativePath.replaceAll("\\", "/");
  const normalized = path.posix.normalize(portablePath);
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized) ||
    /^[A-Za-z]:\//.test(normalized)
  ) {
    throw new ServiceError("无效 blob 路径", 400);
  }
  return path.join(BLOB_ROOT, ...normalized.split("/"));
}

export async function removeArticleBlob(
  relativePath: string | null | undefined,
): Promise<void> {
  if (!relativePath) return;
  try {
    await unlink(resolveArticleBlobPath(relativePath));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export async function streamArticleBlob(
  relativePath: string,
  range?: { start: number; end: number },
): Promise<{ size: number; body: ReadableStream<Uint8Array> }> {
  const absolutePath = resolveArticleBlobPath(relativePath);
  const info = await stat(absolutePath);
  const body = createReadStream(absolutePath, range);
  return {
    size: info.size,
    body: Readable.toWeb(body) as ReadableStream<Uint8Array>,
  };
}

export async function articleBlobSize(relativePath: string): Promise<number> {
  return (await stat(resolveArticleBlobPath(relativePath))).size;
}

/** Server-side renderer compatibility; HTTP downloads use streamArticleBlob. */
export async function readArticleBlob(relativePath: string): Promise<Buffer> {
  return readFile(resolveArticleBlobPath(relativePath));
}
