import crypto from "node:crypto";
import path from "node:path";
import { constants } from "node:fs";
import { copyFile, mkdir, readFile, stat, unlink } from "node:fs/promises";
import { DATA_ROOT } from "@/server/infra/env";
import { ServiceError } from "@/server/services/errors";

const BLOB_ROOT = path.join(DATA_ROOT, "blobs");
const TEACH_BLOB_DIR = "teach";

export interface StoredTeachDocument {
  id: string;
  relativePath: string;
  fileSize: number;
}

export async function copyTeachDocument(
  sourcePath: string,
): Promise<StoredTeachDocument> {
  const source = await stat(sourcePath);
  if (!source.isFile()) throw new ServiceError("源文档不是文件", 400);

  const id = crypto.randomUUID();
  const sourceExtension = path.extname(sourcePath);
  const extension =
    /^\.[a-zA-Z0-9]{1,10}$/.test(sourceExtension) === true
      ? sourceExtension.toLowerCase()
      : "";
  const relativePath = path.posix.join(
    TEACH_BLOB_DIR,
    `${id}${extension}`,
  );
  const absolutePath = resolveTeachDocumentBlobPath(relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  try {
    await copyFile(sourcePath, absolutePath, constants.COPYFILE_EXCL);
    const copied = await stat(absolutePath);
    return { id, relativePath, fileSize: copied.size };
  } catch (error) {
    try {
      await unlink(absolutePath);
    } catch {
      // The copy may have failed before creating its destination.
    }
    throw error;
  }
}

export function resolveTeachDocumentBlobPath(relativePath: string): string {
  const portablePath = relativePath.replaceAll("\\", "/");
  const normalized = path.posix.normalize(portablePath);
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized) ||
    /^[A-Za-z]:\//.test(normalized) ||
    !normalized.startsWith(`${TEACH_BLOB_DIR}/`)
  ) {
    throw new ServiceError("无效文档 blob 路径", 400);
  }
  return path.join(BLOB_ROOT, ...normalized.split("/"));
}

export async function readTeachDocumentBlob(
  relativePath: string,
): Promise<Buffer> {
  return readFile(resolveTeachDocumentBlobPath(relativePath));
}

export async function removeTeachDocumentBlob(
  relativePath: string,
): Promise<void> {
  try {
    await unlink(resolveTeachDocumentBlobPath(relativePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
