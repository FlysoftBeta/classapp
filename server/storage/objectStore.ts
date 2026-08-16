import crypto from "node:crypto";
import {
  copyFile,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import {
  createStorageLayout,
  objectRef,
  resolveObjectPath,
  stagingPath,
  trashPath,
  type ObjectRef,
  type StorageLayout,
} from "./paths";
import { createKeyedLock, type KeyedLock } from "./keyedLock";

export interface ObjectInfo {
  ref: ObjectRef;
  bytes: number;
  sha256: string;
}

export interface BlobRead {
  size: number;
  body: ReadableStream<Uint8Array>;
}

export interface ObjectReadRange {
  /** Inclusive first byte; defaults to 0. */
  start?: number;
  /** Inclusive last byte; defaults to size - 1. Ignored when suffixLength is set. */
  end?: number;
  /** Read the last N bytes (`bytes=-N`). */
  suffixLength?: number;
}

/** Thrown when a requested byte range cannot be satisfied by the stored object. */
export class RangeNotSatisfiableError extends Error {
  constructor(readonly size: number) {
    super(`Object range is not satisfiable for ${size} bytes`);
    this.name = "RangeNotSatisfiableError";
  }
}

function resolveReadRange(
  size: number,
  range: ObjectReadRange | undefined,
): { start: number; end: number } | null {
  if (!range) return { start: 0, end: size - 1 };
  if (range.suffixLength !== undefined) {
    if (!Number.isSafeInteger(range.suffixLength) || range.suffixLength <= 0) {
      return null;
    }
    const start = Math.max(0, size - range.suffixLength);
    if (start >= size) return null;
    return { start, end: size - 1 };
  }
  const start = range.start ?? 0;
  const end = range.end ?? size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  ) {
    return null;
  }
  return { start, end: Math.min(end, size - 1) };
}

export type BlobSource =
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array>
  | Iterable<Uint8Array>
  | Uint8Array;

export interface StagedWrite {
  path: string;
  commit(input?: { bytes?: number; sha256?: string }): Promise<ObjectInfo>;
  discard(): Promise<void>;
}

export interface ObjectStoreOptions {
  /** Stage files older than this are removed by reconcile(). */
  stageRetentionMs: number;
  /** Trashed objects older than this are physically removed. */
  trashRetentionMs: number;
  now?: () => number;
}

const DEFAULT_OPTIONS: ObjectStoreOptions = {
  stageRetentionMs: 60 * 60_000,
  trashRetentionMs: 60_000,
};

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function errorCode(error: unknown): string | null {
  return (error as NodeJS.ErrnoException | null)?.code ?? null;
}

/** Windows-style replacement conflict: target exists but rename could not replace it. */
function isReplaceConflict(error: unknown): boolean {
  const code = errorCode(error);
  return code === "EEXIST" || code === "EPERM";
}

function toAsyncIterable(source: BlobSource): AsyncIterable<Uint8Array> {
  if (source instanceof Uint8Array) {
    return (async function* () {
      yield source;
    })();
  }
  if (Symbol.asyncIterator in Object(source)) {
    return source as AsyncIterable<Uint8Array>;
  }
  if (Symbol.iterator in Object(source)) {
    return (async function* () {
      for (const chunk of source as Iterable<Uint8Array>) yield chunk;
    })();
  }
  return Readable.fromWeb(source as never) as AsyncIterable<Uint8Array>;
}

async function hashFile(absolutePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(absolutePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

async function fsyncFile(absolutePath: string): Promise<void> {
  const handle = await open(absolutePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeIfExists(absolutePath: string): Promise<void> {
  try {
    await rm(absolutePath, { force: true });
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
}

async function writeSourceToFile(
  source: BlobSource,
  absolutePath: string,
): Promise<string> {
  const hash = crypto.createHash("sha256");
  const handle = await open(absolutePath, "wx", 0o600);
  try {
    for await (const chunk of toAsyncIterable(source)) {
      const bytes = chunk as Buffer;
      hash.update(bytes);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const written = await handle.write(
          bytes,
          offset,
          bytes.byteLength - offset,
        );
        offset += written.bytesWritten;
      }
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

/**
 * Single mechanism for disk object bytes. It owns path containment, atomic
 * staging publication, streaming reads, trash, and bounded reconciliation.
 * Domain owners keep authoritative rows in SQLite and treat files as the
 * materialized side effect, exactly as before, but no longer duplicate path
 * rules or stream plumbing per feature.
 */
export class ObjectStore {
  private readonly layout: StorageLayout;
  private readonly options: ObjectStoreOptions;
  private readonly locks: KeyedLock = createKeyedLock();

  constructor(root: string, options: Partial<ObjectStoreOptions> = {}) {
    this.layout = createStorageLayout(root);
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  ref(namespace: ObjectRef["namespace"], key: string): ObjectRef {
    return objectRef(namespace, key);
  }

  /**
   * Final on-disk path for trusted local mechanisms (for example the PDF
   * renderer). Callers must treat it as an opaque input path, never persist it.
   */
  materializedPath(ref: ObjectRef): string {
    return resolveObjectPath(this.layout, ref);
  }

  /** Create a write slot that a producer can fill directly, then commit. */
  async stage(ref: ObjectRef): Promise<StagedWrite> {
    await mkdir(this.layout.stagingRoot, { recursive: true });
    const target = stagingPath(this.layout, ref);
    const stagedRef = ref;
    return {
      path: target,
      commit: (input) => this.commitStage(stagedRef, target, input),
      discard: () => rm(target, { force: true }).catch(() => undefined),
    };
  }

  async putBlob(
    ref: ObjectRef,
    source: BlobSource,
    input: { expectedBytes?: number } = {},
  ): Promise<ObjectInfo> {
    return this.locks.run(ref, async () => {
      const staged = await this.stage(ref);
      try {
        const sha256 = await writeSourceToFile(source, staged.path);
        const info = await stat(staged.path);
        if (
          input.expectedBytes !== undefined &&
          info.size !== input.expectedBytes
        ) {
          throw new Error(
            `Object byte count mismatch: expected ${input.expectedBytes}, got ${info.size}`,
          );
        }
        return await staged.commit({ bytes: info.size, sha256 });
      } catch (error) {
        await staged.discard();
        throw error;
      }
    });
  }

  /**
   * Run an operation while holding this object's per-ref lock. Nested store
   * helpers are safe because only `putBlob`, `copyBlob`, and `trash` acquire
   * the lock; the fd-based read helpers do not.
   */
  withLock<T>(ref: ObjectRef, operation: () => Promise<T> | T): Promise<T> {
    return this.locks.run(ref, operation);
  }

  /**
   * Publish a staged blob without acquiring the per-ref lock. Callers must
   * already hold the lock through `withLock`; this exists for composite
   * stores such as TreeStore whose read-mutate-publish cycle is one operation.
   */
  async putBlobLocked(
    ref: ObjectRef,
    source: BlobSource,
    input: { expectedBytes?: number } = {},
  ): Promise<ObjectInfo> {
    const staged = await this.stage(ref);
    try {
      const sha256 = await writeSourceToFile(source, staged.path);
      const info = await stat(staged.path);
      if (
        input.expectedBytes !== undefined &&
        info.size !== input.expectedBytes
      ) {
        throw new Error(
          `Object byte count mismatch: expected ${input.expectedBytes}, got ${info.size}`,
        );
      }
      return await staged.commit({ bytes: info.size, sha256 });
    } catch (error) {
      await staged.discard();
      throw error;
    }
  }

  async copyBlob(
    ref: ObjectRef,
    sourcePath: string,
    input: { expectedBytes?: number } = {},
  ): Promise<ObjectInfo> {
    return this.locks.run(ref, async () => {
      const source = await stat(sourcePath);
      if (!source.isFile()) throw new Error("Blob copy source is not a file");
      if (
        input.expectedBytes !== undefined &&
        source.size !== input.expectedBytes
      ) {
        throw new Error("Blob copy byte count mismatch");
      }
      const staged = await this.stage(ref);
      try {
        await copyFile(sourcePath, staged.path);
        await fsyncFile(staged.path);
        return await staged.commit({ bytes: source.size });
      } catch (error) {
        await staged.discard();
        throw error;
      }
    });
  }

  async open(ref: ObjectRef, range?: ObjectReadRange): Promise<BlobRead> {
    const absolutePath = resolveObjectPath(this.layout, ref);
    const handle = await open(absolutePath, "r");
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("Object is not a file");
      if (info.size === 0 && !range) {
        await handle.close();
        return {
          size: 0,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close();
            },
          }),
        };
      }
      const resolved = resolveReadRange(info.size, range);
      if (!resolved) {
        throw new RangeNotSatisfiableError(info.size);
      }
      return {
        size: info.size,
        body: webReadable(handle.fd, resolved),
      };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async read(ref: ObjectRef, maxBytes: number): Promise<Buffer> {
    const absolutePath = resolveObjectPath(this.layout, ref);
    const handle = await open(absolutePath, "r");
    try {
      const info = await handle.stat();
      if (info.size > maxBytes) {
        throw new Error(`Object exceeds read bound of ${maxBytes} bytes`);
      }
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  async size(ref: ObjectRef): Promise<number> {
    return (await stat(resolveObjectPath(this.layout, ref))).size;
  }

  /** Reclaim one object through trash; idempotent for missing files. */
  async trash(ref: ObjectRef): Promise<void> {
    return this.locks.run(ref, () => this.trashLocked(ref));
  }

  /** Trash without acquiring the per-ref lock; caller already holds it. */
  async trashLocked(ref: ObjectRef): Promise<void> {
    const source = resolveObjectPath(this.layout, ref);
    const now = this.options.now?.() ?? Date.now();
    const target = trashPath(this.layout, ref, now);
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await rename(source, target);
    } catch (error) {
      if (isEnoent(error)) return;
      if (!isReplaceConflict(error)) throw error;
      // A same-millisecond trash entry already exists; the source bytes are
      // still the authority here, so remove only that generated trash path.
      await removeIfExists(target);
      try {
        await rename(source, target);
      } catch (retryError) {
        if (!isEnoent(retryError)) throw retryError;
      }
    }
    const retentionMs = this.options.trashRetentionMs;
    const timer = setTimeout(() => {
      void rm(target, { force: true }).catch(() => undefined);
    }, retentionMs);
    timer.unref();
  }

  async reconcile(): Promise<void> {
    await mkdir(this.layout.stagingRoot, { recursive: true });
    await this.reconcileStaging();
    await this.reconcileTrash();
  }

  /**
   * Remove final objects in one namespace that no authoritative collector
   * referenced. Domain owners enumerate live keys from SQLite; this is the
   * compensation for crashes between file publish and row publish.
   */
  async reconcileOrphans(
    namespace: ObjectRef["namespace"],
    liveKeys: Iterable<string>,
  ): Promise<number> {
    const expected = new Set<string>();
    for (const key of liveKeys) {
      expected.add(resolveObjectPath(this.layout, objectRef(namespace, key)));
    }
    const namespaceRoot = path.join(this.layout.objectsRoot, namespace);
    const files: string[] = [];
    try {
      await collectObjectFiles(namespaceRoot, files);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const file of files) {
      if (expected.has(file)) continue;
      const now = this.options.now?.() ?? Date.now();
      const target = path.join(
        this.layout.trashRoot,
        namespace,
        `${path.basename(file)}.${now}.orphan`,
      );
      try {
        await mkdir(path.dirname(target), { recursive: true });
        await rename(file, target);
        removed += 1;
        const retentionMs = this.options.trashRetentionMs;
        const timer = setTimeout(() => {
          void rm(target, { force: true }).catch(() => undefined);
        }, retentionMs);
        timer.unref();
      } catch (error) {
        if (!isEnoent(error))
          console.error("[ObjectStore] orphan rename failed", error);
      }
    }
    return removed;
  }

  private async commitStage(
    ref: ObjectRef,
    stagedPath: string,
    input: { bytes?: number; sha256?: string } | undefined,
  ): Promise<ObjectInfo> {
    const info = await stat(stagedPath);
    if (!info.isFile()) throw new Error("Staged object is not a file");
    if (input?.bytes !== undefined && info.size !== input.bytes) {
      throw new Error("Staged object byte count mismatch");
    }
    if (input?.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(input.sha256)) {
      throw new Error("Staged object checksum is invalid");
    }
    await fsyncFile(stagedPath);
    const sha256 = input?.sha256 ?? (await hashFile(stagedPath));
    const target = resolveObjectPath(this.layout, ref);
    await mkdir(path.dirname(target), { recursive: true });

    try {
      await rename(stagedPath, target);
    } catch (error) {
      if (isEnoent(error)) throw new Error("Staged object disappeared");
      if (!isReplaceConflict(error)) throw error;
      // The normal rename path replaces an existing file on both POSIX and
      // Windows. If a platform still reports a replacement conflict, retire the
      // old materialization through trash first and try once more. The database
      // row is authoritative; a crash between the two renames is compensated by
      // startup trash reconciliation, not by deleting the only copy.
      const retired = trashPath(
        this.layout,
        ref,
        this.options.now?.() ?? Date.now(),
      );
      await mkdir(path.dirname(retired), { recursive: true });
      try {
        await rename(target, retired);
      } catch (retireError) {
        if (!isEnoent(retireError)) throw error;
      }
      try {
        await rename(stagedPath, target);
      } catch (retryError) {
        if (isEnoent(retryError)) throw new Error("Staged object disappeared");
        throw retryError;
      }
    }
    return { ref, bytes: info.size, sha256 };
  }

  private async reconcileStaging(): Promise<void> {
    const entries = await readdir(this.layout.stagingRoot).catch(
      () => [] as string[],
    );
    const cutoff =
      (this.options.now?.() ?? Date.now()) - this.options.stageRetentionMs;
    for (const name of entries) {
      if (!name.endsWith(".partial")) continue;
      const target = path.join(this.layout.stagingRoot, name);
      try {
        const info = await stat(target);
        if (info.mtimeMs <= cutoff) await rm(target, { force: true });
      } catch {
        // Concurrent commit/discard wins; a missing entry is already clean.
      }
    }
  }

  private async reconcileTrash(): Promise<void> {
    let namespaces: string[] = [];
    try {
      namespaces = await readdir(this.layout.trashRoot);
    } catch {
      return;
    }
    const cutoff =
      (this.options.now?.() ?? Date.now()) - this.options.trashRetentionMs;
    for (const namespace of namespaces) {
      const directory = path.join(this.layout.trashRoot, namespace);
      const entries = await readdir(directory).catch(() => [] as string[]);
      for (const name of entries) {
        const match = /^[0-9a-f]{64}\.(\d+)\.trash$/.exec(name);
        if (!match || Number(match[1]) > cutoff) continue;
        await rm(path.join(directory, name), { force: true }).catch(
          () => undefined,
        );
      }
    }
  }
}

async function collectObjectFiles(
  directory: string,
  out: string[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectObjectFiles(target, out);
    } else if (entry.isFile() && entry.name.endsWith(".object")) {
      out.push(target);
    }
  }
}

function webReadable(
  fd: number,
  range?: { start: number; end: number },
): ReadableStream<Uint8Array> {
  const options =
    range === undefined ? {} : { start: range.start, end: range.end };
  return Readable.toWeb(
    createReadStream("", { fd, autoClose: true, ...options }),
  ) as ReadableStream<Uint8Array>;
}
