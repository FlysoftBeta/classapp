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
  objectPath,
  stagingPath,
  trashPath,
  type StorageLayout,
} from "./paths";
import { createKeyedLock, type KeyedLock } from "./keyedLock";

export interface BlobInfo {
  id: string;
  bytes: number;
  sha256: string;
}

export interface BlobRead {
  size: number;
  body: ReadableStream<Uint8Array>;
}

export interface BlobReadRange {
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
    super(`Blob range is not satisfiable for ${size} bytes`);
    this.name = "RangeNotSatisfiableError";
  }
}

export type BlobSource =
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array>
  | Iterable<Uint8Array>
  | Uint8Array;

export interface StagingSlot {
  id: string;
  path: string;
  commit(input?: {
    expectedBytes?: number;
    sha256?: string;
    bytes?: number;
  }): Promise<BlobInfo>;
  discard(): Promise<void>;
}

export interface BlobStoreOptions {
  stageRetentionMs: number;
  trashRetentionMs: number;
  now?: () => number;
}

const DEFAULT_OPTIONS: BlobStoreOptions = {
  stageRetentionMs: 60 * 60_000,
  trashRetentionMs: 60_000,
};

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function resolveReadRange(
  size: number,
  range: BlobReadRange | undefined,
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

/**
 * Allocated-id blob bag. It owns path containment, staging publication,
 * streaming reads, trash, and mtime GC of staging/trash only. Domain owners
 * keep authoritative rows in SQLite and treat files as a side effect.
 */
export class BlobStore {
  private readonly layout: StorageLayout;
  private readonly options: BlobStoreOptions;
  private readonly locks: KeyedLock = createKeyedLock();

  constructor(root: string, options: Partial<BlobStoreOptions> = {}) {
    this.layout = createStorageLayout(root);
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Final on-disk path for trusted local mechanisms (for example the PDF
   * renderer). Callers must treat it as an opaque input path, never persist it.
   */
  materializedPath(id: string): string {
    return objectPath(this.layout, id);
  }

  withLock<T>(key: string, operation: () => Promise<T> | T): Promise<T> {
    return this.locks.run(key, operation);
  }

  /** Reserve a unique staging slot. The domain intent row must already name this id. */
  async create(id: string = crypto.randomUUID()): Promise<StagingSlot> {
    await mkdir(this.layout.stagingRoot, { recursive: true });
    const stagedPath = stagingPath(this.layout, id);
    return {
      id,
      path: stagedPath,
      commit: (input) => this.commit(id, input),
      discard: () => rm(stagedPath, { force: true }).catch(() => undefined),
    };
  }

  async put(
    source: BlobSource,
    input: { expectedBytes?: number } = {},
  ): Promise<BlobInfo> {
    const slot = await this.create();
    try {
      await this.writeSlot(slot, source, input.expectedBytes);
      return await slot.commit({ expectedBytes: input.expectedBytes });
    } catch (error) {
      await slot.discard();
      throw error;
    }
  }

  async writeSlot(
    slot: StagingSlot,
    source: BlobSource,
    expectedBytes?: number,
  ): Promise<void> {
    const sha256 = await writeSourceToFile(source, slot.path);
    const info = await stat(slot.path);
    if (expectedBytes !== undefined && info.size !== expectedBytes) {
      throw new Error(
        `Blob byte count mismatch: expected ${expectedBytes}, got ${info.size}`,
      );
    }
    void sha256;
  }

  async copyFrom(
    sourcePath: string,
    input: { expectedBytes?: number } = {},
  ): Promise<BlobInfo> {
    const source = await stat(sourcePath);
    if (!source.isFile()) throw new Error("Blob copy source is not a file");
    if (
      input.expectedBytes !== undefined &&
      source.size !== input.expectedBytes
    ) {
      throw new Error("Blob copy byte count mismatch");
    }
    const slot = await this.create();
    try {
      await copyFile(sourcePath, slot.path);
      await fsyncFile(slot.path);
      return await slot.commit({ expectedBytes: source.size });
    } catch (error) {
      await slot.discard();
      throw error;
    }
  }

  async open(id: string, range?: BlobReadRange): Promise<BlobRead> {
    const absolutePath = objectPath(this.layout, id);
    const handle = await open(absolutePath, "r");
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("Blob is not a file");
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

  async read(id: string, maxBytes: number): Promise<Buffer> {
    const absolutePath = objectPath(this.layout, id);
    const handle = await open(absolutePath, "r");
    try {
      const info = await handle.stat();
      if (info.size > maxBytes) {
        throw new Error(`Blob exceeds read bound of ${maxBytes} bytes`);
      }
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  async size(id: string): Promise<number> {
    return (await stat(objectPath(this.layout, id))).size;
  }

  /** Reclaim one blob through trash; idempotent for missing files. */
  async drop(id: string): Promise<void> {
    return this.locks.run(id, () => this.dropLocked(id));
  }

  async dropLocked(id: string): Promise<void> {
    const source = objectPath(this.layout, id);
    const target = trashPath(this.layout, id);
    try {
      await mkdir(this.layout.trashRoot, { recursive: true });
      await rename(source, target);
    } catch (error) {
      if (isEnoent(error)) return;
      throw error;
    }
  }

  /** Delete aged staging and trash files. Never walks objects/. */
  async gc(): Promise<void> {
    await this.gcDirectory(
      this.layout.stagingRoot,
      this.options.stageRetentionMs,
    );
    await this.gcDirectory(this.layout.trashRoot, this.options.trashRetentionMs);
  }

  private async commit(
    id: string,
    input:
      | { expectedBytes?: number; sha256?: string; bytes?: number }
      | undefined,
  ): Promise<BlobInfo> {
    return this.locks.run(id, async () => {
      const stagedPath = stagingPath(this.layout, id);
      const info = await stat(stagedPath);
      if (!info.isFile()) throw new Error("Staged blob is not a file");
      const expected = input?.expectedBytes ?? input?.bytes;
      if (expected !== undefined && info.size !== expected) {
        throw new Error("Staged blob byte count mismatch");
      }
      if (input?.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(input.sha256)) {
        throw new Error("Staged blob checksum is invalid");
      }
      await fsyncFile(stagedPath);
      const sha256 = input?.sha256 ?? (await hashFile(stagedPath));
      const target = objectPath(this.layout, id);
      await mkdir(path.dirname(target), { recursive: true });
      await rename(stagedPath, target);
      return { id, bytes: info.size, sha256 };
    });
  }

  private async gcDirectory(
    directory: string,
    retentionMs: number,
  ): Promise<void> {
    const cutoff = (this.options.now?.() ?? Date.now()) - retentionMs;
    let names: string[] = [];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (isEnoent(error)) return;
      throw error;
    }
    for (const name of names) {
      const target = path.join(directory, name);
      try {
        const info = await stat(target);
        if (!info.isFile()) continue;
        if (info.mtimeMs <= cutoff) await rm(target, { force: true });
      } catch {
        // Concurrent commit/discard wins; a missing entry is already clean.
      }
    }
  }
}

/** @deprecated Use BlobReadRange. Kept as an alias for HTTP range helpers. */
export type ObjectReadRange = BlobReadRange;
