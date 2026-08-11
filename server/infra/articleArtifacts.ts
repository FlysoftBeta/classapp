import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { bytes, formatBytes } from "@/shared/bytes";
import { DATA_ROOT } from "@/server/infra/env";
import { renderPdfArchive } from "@/server/infra/pdfRenderProcess";
import {
  forgetRenderArchive,
  inspectRenderArchive,
} from "@/server/infra/renderArchive";
import {
  attachSuppressedError,
  PublicError,
} from "@/server/services/incidentService";

const BLOB_ROOT = path.join(DATA_ROOT, "blobs");
const ARTICLE_DIR = "articles";
const MAX_SOURCE_BYTES = bytes("200 MB");

export interface StoredArticleBundle {
  sourcePath: string;
  archivePath: string;
  sourceMime: "application/pdf";
  sourceSize: number;
  archiveSize: number;
  originalFilename: string;
  itemCount: number;
}

function normalizeArticleMime(file: File): StoredArticleBundle["sourceMime"] {
  const name = file.name.toLowerCase();
  if (file.type === "application/pdf" || name.endsWith(".pdf")) {
    return "application/pdf";
  }
  throw new PublicError("仅支持 PDF 文件");
}

function normalizeArtifactPath(relativePath: string): string {
  const normalized = path.posix.normalize(relativePath.replaceAll("\\", "/"));
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized) ||
    /^[A-Za-z]:\//.test(normalized)
  ) {
    throw new PublicError("无效文档路径");
  }
  return normalized;
}

export function resolveArticleArtifactPath(relativePath: string): string {
  return path.join(
    BLOB_ROOT,
    ...normalizeArtifactPath(relativePath).split("/"),
  );
}

/** Persist the source first, render once, then publish the validated archive. */
export async function storeArticleBundle(
  file: File,
): Promise<StoredArticleBundle> {
  if (!file.size) throw new PublicError("文件不能为空");
  if (file.size > MAX_SOURCE_BYTES) {
    throw new PublicError(`文件不能超过 ${formatBytes(MAX_SOURCE_BYTES)}`);
  }
  const sourceMime = normalizeArticleMime(file);
  const key = crypto.randomUUID();
  const relativeDir = path.posix.join(ARTICLE_DIR, key);
  const absoluteDir = resolveArticleArtifactPath(relativeDir);
  const sourcePath = path.posix.join(relativeDir, "source.pdf");
  const archivePath = path.posix.join(relativeDir, "render.zip");
  const absoluteSource = resolveArticleArtifactPath(sourcePath);
  const absoluteArchive = resolveArticleArtifactPath(archivePath);
  const temporaryArchive = path.join(absoluteDir, "render.pending.zip");

  await mkdir(absoluteDir, { recursive: true });
  try {
    await writeFile(absoluteSource, Buffer.from(await file.arrayBuffer()), {
      flag: "wx",
    });
    await renderPdfArchive(absoluteSource, temporaryArchive);
    const index = await inspectRenderArchive(temporaryArchive);
    await rename(temporaryArchive, absoluteArchive);
    return {
      sourcePath,
      archivePath,
      sourceMime,
      sourceSize: file.size,
      archiveSize: index.archiveSize,
      originalFilename: file.name || "document.pdf",
      itemCount: index.header.item_count,
    };
  } catch (error) {
    try {
      await rm(absoluteDir, { recursive: true, force: true });
    } catch (cleanupError) {
      attachSuppressedError(error, cleanupError);
    }
    throw error;
  }
}

export async function removeArticleBundle(
  sourcePath: string | null | undefined,
  archivePath: string | null | undefined,
): Promise<void> {
  if (archivePath) forgetRenderArchive(archivePath);
  const available = [sourcePath, archivePath].filter(
    (value): value is string => !!value,
  );
  if (!available.length) return;
  const directories = new Set(
    available.map((value) => path.dirname(resolveArticleArtifactPath(value))),
  );
  await Promise.all(
    [...directories].map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
}

export async function streamArticleSource(
  relativePath: string,
  range?: { start: number; end: number },
): Promise<{ size: number; body: ReadableStream<Uint8Array> }> {
  const absolutePath = resolveArticleArtifactPath(relativePath);
  const info = await stat(absolutePath);
  return {
    size: info.size,
    body: Readable.toWeb(
      createReadStream(absolutePath, range),
    ) as ReadableStream<Uint8Array>,
  };
}

export async function articleSourceSize(relativePath: string): Promise<number> {
  return (await stat(resolveArticleArtifactPath(relativePath))).size;
}
