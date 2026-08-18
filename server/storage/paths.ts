import path from "node:path";

const BLOB_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Reject anything that is not an allocated blob UUID. */
export function normalizeBlobId(id: string): string {
  if (typeof id !== "string" || !BLOB_ID.test(id)) {
    throw new Error("Invalid blob id");
  }
  return id.toLowerCase();
}

/** Logical paths inside a manifest tree; stronger rules than blob ids. */
export function normalizeTreePath(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) {
    throw new Error("Invalid tree path length");
  }
  if (value.includes("\\") || /[\u0000-\u001f]/.test(value)) {
    throw new Error("Invalid tree path characters");
  }
  const normalized = path.posix.normalize(value.trim());
  if (
    normalized !== value.trim() ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized) ||
    /^[A-Za-z]:/.test(normalized)
  ) {
    throw new Error("Invalid tree path");
  }
  const segments = normalized.split("/");
  if (
    segments.length > 16 ||
    segments.some((segment) => segment === "." || segment === ".." || !segment)
  ) {
    throw new Error("Invalid tree path segment");
  }
  return normalized;
}

export interface StorageLayout {
  root: string;
  objectsRoot: string;
  stagingRoot: string;
  trashRoot: string;
}

export function createStorageLayout(root: string): StorageLayout {
  const resolved = path.resolve(root);
  return {
    root: resolved,
    objectsRoot: path.join(resolved, "objects"),
    stagingRoot: path.join(resolved, "staging"),
    trashRoot: path.join(resolved, "trash"),
  };
}

function shard(id: string): { a: string; b: string } {
  const compact = normalizeBlobId(id).replaceAll("-", "");
  return { a: compact.slice(0, 2), b: compact.slice(2, 4) };
}

export function objectPath(layout: StorageLayout, id: string): string {
  const blobId = normalizeBlobId(id);
  const { a, b } = shard(blobId);
  return path.join(layout.objectsRoot, a, b, blobId);
}

export function stagingPath(layout: StorageLayout, id: string): string {
  return path.join(layout.stagingRoot, normalizeBlobId(id));
}

export function trashPath(layout: StorageLayout, id: string): string {
  return path.join(layout.trashRoot, normalizeBlobId(id));
}
