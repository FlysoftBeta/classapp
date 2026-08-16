import crypto from "node:crypto";
import path from "node:path";

export const STORAGE_NAMESPACES = [
  "ai-workspaces",
  "media",
  "teach-documents",
  "article-bundles",
] as const;

export type StorageNamespace = (typeof STORAGE_NAMESPACES)[number];

/**
 * A validated reference to one stored object. The key is an owner-chosen,
 * URL-like identifier; it never names a host path and may not contain
 * traversal or platform separators.
 */
export interface ObjectRef {
  namespace: StorageNamespace;
  key: string;
}

export function objectRef(namespace: StorageNamespace, key: string): ObjectRef {
  return { namespace, key: normalizeObjectKey(key) };
}

const OBJECT_KEY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const OBJECT_KEY_MAX_LENGTH = 200;
const OBJECT_KEY_MAX_DEPTH = 4;

/** Reject path-like input instead of silently repairing it. */
export function normalizeObjectKey(key: string): string {
  if (typeof key !== "string" || key.length === 0 || key.length > OBJECT_KEY_MAX_LENGTH) {
    throw new Error(`Invalid object key length: ${key.length}`);
  }
  if (key.includes("\\") || /[\u0000-\u001f]/.test(key)) {
    throw new Error("Invalid object key characters");
  }
  const segments = key.split("/");
  if (segments.length > OBJECT_KEY_MAX_DEPTH) {
    throw new Error("Object key has too many segments");
  }
  if (segments.some((segment) => !OBJECT_KEY_SEGMENT.test(segment))) {
    throw new Error("Invalid object key segment");
  }
  return segments.join("/");
}

/** Logical paths inside a manifest tree; stronger rules than object keys. */
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

/**
 * Content-sharded final location. The on-disk name contains only a digest, so
 * owner keys (including user IDs) never leak into filesystem names.
 */
export function resolveObjectPath(
  layout: StorageLayout,
  ref: ObjectRef,
): string {
  const digest = crypto
    .createHash("sha256")
    .update(`${ref.namespace}\u0000${normalizeObjectKey(ref.key)}`)
    .digest("hex");
  return path.join(
    layout.objectsRoot,
    ref.namespace,
    digest.slice(0, 2),
    digest.slice(2, 4),
    `${digest}.object`,
  );
}

export function stagingPath(layout: StorageLayout, ref: ObjectRef): string {
  const digest = crypto
    .createHash("sha256")
    .update(`${ref.namespace}\u0000${normalizeObjectKey(ref.key)}`)
    .digest("hex");
  return path.join(layout.stagingRoot, `${digest}.${crypto.randomUUID()}.partial`);
}

export function trashPath(
  layout: StorageLayout,
  ref: ObjectRef,
  atMs: number,
): string {
  const digest = crypto
    .createHash("sha256")
    .update(`${ref.namespace}\u0000${normalizeObjectKey(ref.key)}`)
    .digest("hex");
  return path.join(
    layout.trashRoot,
    ref.namespace,
    `${digest}.${atMs}.trash`,
  );
}
