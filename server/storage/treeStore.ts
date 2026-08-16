import crypto from "node:crypto";
import { unzipSync, zipSync } from "fflate";
import { z } from "zod";
import { createKeyedLock } from "./keyedLock";
import type { ObjectStore } from "./objectStore";
import { normalizeTreePath, type ObjectRef } from "./paths";

const MANIFEST_NAME = "manifest.json";
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_MANIFEST_ENTRIES = 10_000;
const MAX_ENTRY_BYTES = 512 * 1024 * 1024;

const treeEntrySchema = z
  .object({
    id: z.string().uuid(),
    path: z.string().min(1).max(1024),
    mime: z.string().min(1).max(255),
    size: z.number().int().nonnegative().max(MAX_ENTRY_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    updatedAt: z.string().datetime(),
  })
  .strict();

const treeManifestSchema = z
  .object({
    format: z.literal("classapp-object-tree"),
    version: z.literal(1),
    revision: z.number().int().nonnegative(),
    entries: z.array(treeEntrySchema).max(MAX_MANIFEST_ENTRIES),
  })
  .strict();

type TreeManifest = z.infer<typeof treeManifestSchema>;
type TreeManifestEntry = z.infer<typeof treeEntrySchema>;

export interface TreeFile {
  path: string;
  mime: string;
  size: number;
  sha256: string;
  updatedAt: string;
}

export interface TreeSnapshot {
  revision: number;
  totalBytes: number;
  files: TreeFile[];
  read(path: string): { entry: TreeFile; bytes: Uint8Array } | null;
}

export interface TreeLimits {
  /** Logical payload byte limit. */
  maxBytes: number;
  maxFiles: number;
  maxPathDepth: number;
  /** Encoded archive read bound, covering manifest and ZIP overhead. */
  maxArchiveBytes: number;
}

export type TreeMutation = (tree: EditableTree) => void | Promise<void>;

function payloadName(id: string): string {
  return `objects/${id}`;
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function publicFile(entry: TreeManifestEntry): TreeFile {
  return {
    path: entry.path,
    mime: entry.mime,
    size: entry.size,
    sha256: entry.sha256,
    updatedAt: entry.updatedAt,
  };
}

function parseManifest(bytes: Uint8Array): TreeManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Tree manifest is not valid JSON");
  }
  const parsed = treeManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("Tree manifest contract is invalid");
  }
  return parsed.data;
}

function loadFromArchive(archive: Uint8Array): LoadedTree {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(archive);
  } catch {
    throw new Error("Tree archive is not readable");
  }
  const manifestBytes = entries[MANIFEST_NAME];
  if (!manifestBytes || manifestBytes.byteLength > MAX_MANIFEST_BYTES) {
    throw new Error("Tree archive manifest is missing or too large");
  }
  const manifest = parseManifest(manifestBytes);
  const expected = new Set<string>([MANIFEST_NAME]);
  const byPath = new Map<string, TreeManifestEntry>();
  const byId = new Map<string, TreeManifestEntry>();
  for (const entry of manifest.entries) {
    const normalized = normalizeTreePath(entry.path);
    if (normalized !== entry.path || byPath.has(normalized) || byId.has(entry.id)) {
      throw new Error("Tree manifest contains a duplicate or invalid path");
    }
    const bytes = entries[payloadName(entry.id)];
    if (!bytes || bytes.byteLength !== entry.size) {
      throw new Error("Tree archive payload does not match its manifest");
    }
    byPath.set(normalized, entry);
    byId.set(entry.id, entry);
    expected.add(payloadName(entry.id));
  }
  for (const name of Object.keys(entries)) {
    if (!name.endsWith("/") && !expected.has(name)) {
      throw new Error("Tree archive contains an unexpected entry");
    }
  }
  return new LoadedTree(manifest.revision, byPath, entries);
}

/** One validated tree snapshot plus its archive payload, kept in memory. */
class LoadedTree implements TreeSnapshot {
  constructor(
    readonly revision: number,
    private readonly byPath: Map<string, TreeManifestEntry>,
    private readonly payloads: Record<string, Uint8Array>,
  ) {}

  get totalBytes(): number {
    let total = 0;
    for (const entry of this.byPath.values()) total += entry.size;
    return total;
  }

  get files(): TreeFile[] {
    return [...this.byPath.values()]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map(publicFile);
  }

  read(path: string) {
    const entry = this.byPath.get(normalizeTreePath(path));
    const bytes = entry ? this.payloads[payloadName(entry.id)] : undefined;
    if (!entry || !bytes) return null;
    if (sha256(bytes) !== entry.sha256) {
      throw new Error("Tree entry failed its checksum");
    }
    return { entry: publicFile(entry), bytes };
  }

  toEditable(): EditableTree {
    return new EditableTree(this.revision, this.byPath, this.payloads);
  }
}

function encodeArchive(
  revision: number,
  byPath: Map<string, TreeManifestEntry>,
  payloads: Record<string, Uint8Array>,
): Uint8Array {
  const entries = [...byPath.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const manifest: TreeManifest = { format: "classapp-object-tree", version: 1, revision, entries };
  const archive: Record<string, Uint8Array> = {
    [MANIFEST_NAME]: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
  };
  for (const entry of entries) archive[payloadName(entry.id)] = payloads[payloadName(entry.id)]!;
  return zipSync(archive, { level: 6 });
}

/**
 * Mutable working copy used inside one `TreeStore.mutate` operation. The store
 * publishes a freshly encoded manifest archive only after limits pass.
 */
export class EditableTree {
  constructor(
    readonly revision: number,
    private readonly byPath: Map<string, TreeManifestEntry>,
    private readonly payloads: Record<string, Uint8Array>,
  ) {}

  has(path: string): boolean {
    return this.byPath.has(normalizeTreePath(path));
  }

  get(path: string): { entry: TreeFile; bytes: Uint8Array } | null {
    const normalized = normalizeTreePath(path);
    const entry = this.byPath.get(normalized);
    const bytes = entry ? this.payloads[payloadName(entry.id)] : undefined;
    if (!entry || !bytes) return null;
    return { entry: publicFile(entry), bytes };
  }

  put(path: string, bytes: Uint8Array, mime: string, updatedAt: string): TreeFile {
    const normalized = normalizeTreePath(path);
    const entry: TreeManifestEntry = {
      id: crypto.randomUUID(),
      path: normalized,
      mime,
      size: bytes.byteLength,
      sha256: sha256(bytes),
      updatedAt,
    };
    this.byPath.set(normalized, entry);
    this.payloads[payloadName(entry.id)] = bytes;
    return publicFile(entry);
  }

  delete(path: string): boolean {
    const normalized = normalizeTreePath(path);
    const entry = this.byPath.get(normalized);
    if (!entry) return false;
    this.byPath.delete(normalized);
    delete this.payloads[payloadName(entry.id)];
    return true;
  }

  get totalBytes(): number {
    let total = 0;
    for (const entry of this.byPath.values()) total += entry.size;
    return total;
  }

  get fileCount(): number {
    return this.byPath.size;
  }

  get files(): TreeFile[] {
    return [...this.byPath.values()]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map(publicFile);
  }

  validate(limits: TreeLimits): void {
    if (this.totalBytes > limits.maxBytes) {
      throw new Error(`Tree exceeds ${limits.maxBytes} bytes`);
    }
    if (this.fileCount > limits.maxFiles) {
      throw new Error(`Tree exceeds ${limits.maxFiles} files`);
    }
    for (const path of this.byPath.keys()) {
      if (path.split("/").length > limits.maxPathDepth) {
        throw new Error(`Tree path exceeds depth ${limits.maxPathDepth}`);
      }
    }
  }

  toArchiveBytes(revision: number = this.revision): Uint8Array {
    return encodeArchive(revision, this.byPath, this.payloads);
  }
}

/**
 * Manifest-based complex objects. A tree is one ZIP blob: `manifest.json`
 * plus content-addressed payload entries. Metadata therefore scales with file
 * count only inside that single manifest, while single-blob consumers keep
 * raw files with no metadata at all.
 */
export class TreeStore {
  private readonly locks = createKeyedLock();

  constructor(private readonly store: ObjectStore) {}

  async inspect(ref: ObjectRef, limits: TreeLimits): Promise<TreeSnapshot> {
    return this.locks.run(ref, () => this.load(ref, limits));
  }

  async read(
    ref: ObjectRef,
    limits: TreeLimits,
    path: string,
  ): Promise<{ entry: TreeFile; bytes: Uint8Array } | null> {
    return this.locks.run(ref, async () => {
      const tree = await this.load(ref, limits);
      return tree.read(path);
    });
  }

  /**
   * Load, mutate, validate, and atomically republish in one per-object lock.
   * Mutators never see another request's intermediate state.
   */
  async mutate(
    ref: ObjectRef,
    limits: TreeLimits,
    mutation: TreeMutation,
  ): Promise<TreeSnapshot> {
    return this.locks.run(ref, async () => {
      const loaded = await this.load(ref, limits);
      const editable = loaded.toEditable();
      await mutation(editable);
      editable.validate(limits);
      const revision = editable.revision + 1;
      const archive = editable.toArchiveBytes(revision);
      await this.store.putBlob(ref, archive, { expectedBytes: archive.byteLength });
      const parsed = loadFromArchive(archive);
      if (parsed.revision !== revision) throw new Error("Tree revision mismatch");
      return parsed;
    });
  }

  async remove(ref: ObjectRef): Promise<void> {
    return this.locks.run(ref, () => this.store.trash(ref));
  }

  private async load(ref: ObjectRef, limits: TreeLimits): Promise<LoadedTree> {
    try {
      const bytes = await this.store.read(ref, limits.maxArchiveBytes);
      const tree = loadFromArchive(new Uint8Array(bytes));
      tree.toEditable().validate(limits);
      return tree;
    } catch (error) {
      if (isEnoent(error)) {
        return new LoadedTree(0, new Map(), {});
      }
      throw error;
    }
  }
}
