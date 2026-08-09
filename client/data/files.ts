import { requestResult, runTransaction } from "./idb";
import { STORES } from "./schema";

export const EXTENT_SIZE = 4 * 1024 * 1024;
const MAX_EXTENTS_PER_TRANSACTION = 4;
const STREAM_CHUNK_SIZE = 256 * 1024;

const localLockTails = new Map<string, Promise<void>>();

async function withLocalFileLock<T>(
  id: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = localLockTails.get(id) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  localLockTails.set(id, tail);
  await previous.catch(() => undefined);
  try {
    return await run();
  } finally {
    release();
    if (localLockTails.get(id) === tail) localLockTails.delete(id);
  }
}

export interface FileHead {
  id: string;
  physical_id: string;
  size: number;
  state: "complete" | "mutating";
  created_at: number;
  checksum: string | null;
  operation?: "grow" | "shrink";
  target_size?: number;
}

function assertSize(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function extentCount(size: number): number {
  return size === 0 ? 0 : Math.ceil(size / EXTENT_SIZE);
}

function extentLength(size: number, extent: number): number {
  const remaining = size - extent * EXTENT_SIZE;
  return Math.min(EXTENT_SIZE, Math.max(0, remaining));
}

function fileLockName(id: string): string {
  return `classapp:file:${id}`;
}

async function withFileLock<T>(
  id: string,
  mode: "shared" | "exclusive",
  run: () => Promise<T>,
): Promise<T> {
  const locks = navigator.locks;
  if (!locks) return withLocalFileLock(id, run);
  return locks.request(fileLockName(id), { mode }, run);
}

async function readHead(id: string): Promise<FileHead | null> {
  return runTransaction(STORES.FILE_HEADS, "readonly", async (tx) => {
    const row = await requestResult(tx.objectStore(STORES.FILE_HEADS).get(id));
    return (row as FileHead | undefined) ?? null;
  });
}

async function putHead(head: FileHead): Promise<void> {
  await runTransaction(STORES.FILE_HEADS, "readwrite", (tx) => {
    tx.objectStore(STORES.FILE_HEADS).put(head);
  });
}

async function readPhysicalExtent(
  physicalId: string,
  extent: number,
): Promise<ArrayBuffer | null> {
  return runTransaction(STORES.FILES, "readonly", async (tx) => {
    const value = await requestResult(
      tx.objectStore(STORES.FILES).get([physicalId, extent]),
    );
    return (value as ArrayBuffer | undefined) ?? null;
  });
}

async function putPhysicalExtent(
  physicalId: string,
  extent: number,
  value: ArrayBuffer,
): Promise<void> {
  if (value.byteLength <= 0 || value.byteLength > EXTENT_SIZE) {
    throw new Error("Invalid file extent length");
  }
  await runTransaction(STORES.FILES, "readwrite", (tx) => {
    tx.objectStore(STORES.FILES).put(value, [physicalId, extent]);
  });
}

async function deletePhysical(
  physicalId: string,
  count: number,
): Promise<void> {
  for (let start = 0; start < count; start += MAX_EXTENTS_PER_TRANSACTION) {
    const end = Math.min(count, start + MAX_EXTENTS_PER_TRANSACTION);
    await runTransaction(STORES.FILES, "readwrite", (tx) => {
      const store = tx.objectStore(STORES.FILES);
      for (let extent = start; extent < end; extent += 1) {
        store.delete([physicalId, extent]);
      }
    });
  }
}

async function deletePhysicalKeys(
  keys: Array<[string, number]>,
): Promise<void> {
  for (
    let start = 0;
    start < keys.length;
    start += MAX_EXTENTS_PER_TRANSACTION
  ) {
    const batch = keys.slice(start, start + MAX_EXTENTS_PER_TRANSACTION);
    await runTransaction(STORES.FILES, "readwrite", (tx) => {
      const store = tx.objectStore(STORES.FILES);
      for (const key of batch) store.delete(key);
    });
  }
}

function physicalId(id: string): string {
  const random = new Uint32Array(2);
  crypto.getRandomValues(random);
  return `${id}@${Date.now().toString(36)}-${random[0]!.toString(36)}${random[1]!.toString(36)}`;
}

function copyView(view: ArrayBufferView): ArrayBuffer {
  const copy = new Uint8Array(view.byteLength);
  copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  return copy.buffer;
}

/** Extent-backed binary files with staged, atomic generation publication. */
export class ExtentFileStore {
  async size(id: string): Promise<number | null> {
    return withFileLock(
      id,
      "exclusive",
      async () => (await this.recoverHead(await readHead(id)))?.size ?? null,
    );
  }

  async list(prefix = ""): Promise<FileHead[]> {
    return runTransaction(STORES.FILE_HEADS, "readonly", async (tx) => {
      const rows = (await requestResult(
        tx.objectStore(STORES.FILE_HEADS).getAll(),
      )) as FileHead[];
      return prefix ? rows.filter((row) => row.id.startsWith(prefix)) : rows;
    });
  }

  async read(id: string, offset: number, length: number): Promise<ArrayBuffer> {
    assertSize(offset, "offset");
    assertSize(length, "length");
    await this.ensureComplete(id);
    return withFileLock(id, "shared", async () => {
      const head = await readHead(id);
      if (!head) throw new Error(`File does not exist: ${id}`);
      if (offset + length > head.size) throw new RangeError("Read past EOF");
      const output = new Uint8Array(length);
      let written = 0;
      while (written < length) {
        const absolute = offset + written;
        const extent = Math.floor(absolute / EXTENT_SIZE);
        const inExtent = absolute % EXTENT_SIZE;
        const value = await readPhysicalExtent(head.physical_id, extent);
        if (!value) throw new Error(`Missing extent ${extent} for ${id}`);
        const source = new Uint8Array(value);
        const amount = Math.min(length - written, source.length - inExtent);
        output.set(source.subarray(inExtent, inExtent + amount), written);
        written += amount;
      }
      return output.buffer;
    });
  }

  async grow(id: string, size: number): Promise<void> {
    assertSize(size, "size");
    await withFileLock(id, "exclusive", async () => {
      const old = await this.recoverHead(await readHead(id));
      const oldSize = old?.size ?? 0;
      if (size < oldSize) throw new RangeError("grow cannot shrink a file");
      if (size === oldSize && old) return;
      if (!old) {
        const head: FileHead = {
          id,
          physical_id: physicalId(id),
          size: 0,
          state: "complete",
          created_at: Date.now(),
          checksum: null,
        };
        await putHead(head);
        await this.mutateSize(head, "grow", size);
        return;
      }
      await this.mutateSize(old, "grow", size);
    });
  }

  async shrink(id: string, size: number): Promise<void> {
    assertSize(size, "size");
    await withFileLock(id, "exclusive", async () => {
      const old = await this.recoverHead(await readHead(id));
      if (!old) throw new Error(`File does not exist: ${id}`);
      if (size > old.size) throw new RangeError("shrink cannot grow a file");
      if (size === old.size) return;
      await this.mutateSize(old, "shrink", size);
    });
  }

  async write(
    id: string,
    offset: number,
    data: ArrayBufferView,
  ): Promise<void> {
    assertSize(offset, "offset");
    await withFileLock(id, "exclusive", async () => {
      const old = await this.recoverHead(await readHead(id));
      if (!old) throw new Error(`File does not exist: ${id}`);
      if (offset + data.byteLength > old.size) {
        throw new RangeError("write cannot grow a file");
      }
      if (!data.byteLength) return;
      if (old.checksum !== null) {
        // In-place writes invalidate the content identity before the first
        // extent changes, so a crash can never leave a stale checksum claim.
        old.checksum = null;
        await putHead(old);
      }
      const source = new Uint8Array(
        data.buffer,
        data.byteOffset,
        data.byteLength,
      );
      let consumed = 0;
      while (consumed < source.length) {
        const absolute = offset + consumed;
        const extent = Math.floor(absolute / EXTENT_SIZE);
        const inExtent = absolute % EXTENT_SIZE;
        const current = await readPhysicalExtent(old.physical_id, extent);
        if (!current) throw new Error(`Missing extent ${extent} for ${id}`);
        const next = new Uint8Array(current.slice(0));
        const amount = Math.min(
          source.length - consumed,
          next.length - inExtent,
        );
        next.set(source.subarray(consumed, consumed + amount), inExtent);
        await putPhysicalExtent(old.physical_id, extent, next.buffer);
        consumed += amount;
      }
    });
  }

  async delete(id: string): Promise<void> {
    await withFileLock(id, "exclusive", async () => {
      const head = await this.recoverHead(await readHead(id));
      if (!head) return;
      await runTransaction(STORES.FILE_HEADS, "readwrite", (tx) => {
        tx.objectStore(STORES.FILE_HEADS).delete(id);
      });
      await deletePhysical(head.physical_id, extentCount(head.size));
    });
  }

  async replace(
    id: string,
    expectedSize: number,
    source: ReadableStream<Uint8Array> | ArrayBuffer,
    checksum: string | null = null,
  ): Promise<void> {
    assertSize(expectedSize, "expectedSize");
    await withFileLock(id, "exclusive", async () => {
      await this.publishGeneration(
        id,
        expectedSize,
        async (writer) => {
          if (source instanceof ArrayBuffer) {
            await writer.write(source);
            return;
          }
          const reader = source.getReader();
          try {
            while (true) {
              const result = await reader.read();
              if (result.done) break;
              await writer.write(copyView(result.value));
            }
          } finally {
            reader.releaseLock();
          }
        },
        checksum,
      );
    });
  }

  /** Opens a sequential reader whose position may be moved without loading the file. */
  cursor(id: string, position = 0): ExtentFileCursor {
    assertSize(position, "position");
    return new ExtentFileCursor(this, id, position);
  }

  /**
   * Streams one pinned file generation. A shared lock is retained until EOF or
   * cancellation, so a concurrent replace cannot delete extents mid-stream.
   */
  stream(
    id: string,
    options: { offset?: number; length?: number } = {},
  ): ReadableStream<Uint8Array> {
    const offset = options.offset ?? 0;
    assertSize(offset, "offset");
    if (options.length !== undefined) assertSize(options.length, "length");

    let head: FileHead | null = null;
    let position = offset;
    let remaining = options.length ?? Number.MAX_SAFE_INTEGER;
    let release!: () => void;
    let failReady!: (error: unknown) => void;
    let markReady!: () => void;
    const ready = new Promise<void>((resolve, reject) => {
      markReady = resolve;
      failReady = reject;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });

    const ensure = this.ensureComplete(id);
    void ensure
      .then(() =>
        withFileLock(id, "shared", async () => {
          try {
            head = await readHead(id);
            if (!head) throw new Error(`File does not exist: ${id}`);
            if (offset > head.size)
              throw new RangeError("Stream starts past EOF");
            remaining = Math.min(remaining, head.size - offset);
            markReady();
            await released;
          } catch (error) {
            failReady(error);
            release();
          }
        }),
      )
      .catch(failReady);

    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          await ready;
          if (!head || remaining === 0) {
            controller.close();
            release();
            return;
          }
          const length = Math.min(STREAM_CHUNK_SIZE, remaining);
          const chunk = await this.readUnlocked(head, position, length);
          position += length;
          remaining -= length;
          controller.enqueue(new Uint8Array(chunk));
        } catch (error) {
          controller.error(error);
          release();
        }
      },
      cancel: () => release(),
    });
  }

  /** Removes bounded unpublished generations left by interrupted writes. */
  async collectOrphans(limit = 32): Promise<number> {
    assertSize(limit, "limit");
    if (!limit) return 0;
    const keys = await runTransaction(
      [STORES.FILE_HEADS, STORES.FILES],
      "readonly",
      async (tx) => {
        const heads = (await requestResult(
          tx.objectStore(STORES.FILE_HEADS).getAll(),
        )) as FileHead[];
        const live = new Set(heads.map((head) => head.physical_id));
        const orphaned: Array<[string, number]> = [];
        const request = tx.objectStore(STORES.FILES).openKeyCursor();
        await new Promise<void>((resolve, reject) => {
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor || orphaned.length >= limit) {
              resolve();
              return;
            }
            const key = cursor.key as [string, number];
            if (!live.has(key[0])) orphaned.push(key);
            cursor.continue();
          };
        });
        return orphaned;
      },
    );
    await deletePhysicalKeys(keys);
    return keys.length;
  }

  private async readUnlocked(
    head: FileHead,
    offset: number,
    length: number,
  ): Promise<ArrayBuffer> {
    const output = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      const absolute = offset + written;
      const extent = Math.floor(absolute / EXTENT_SIZE);
      const inExtent = absolute % EXTENT_SIZE;
      const value = await readPhysicalExtent(head.physical_id, extent);
      if (!value) throw new Error(`Missing extent ${extent} for ${head.id}`);
      const source = new Uint8Array(value);
      const amount = Math.min(length - written, source.length - inExtent);
      output.set(source.subarray(inExtent, inExtent + amount), written);
      written += amount;
    }
    return output.buffer;
  }

  private async ensureComplete(id: string): Promise<void> {
    await withFileLock(id, "exclusive", async () => {
      await this.recoverHead(await readHead(id));
    });
  }

  private async recoverHead(head: FileHead | null): Promise<FileHead | null> {
    if (!head || head.state === "complete") return head;
    const operation = head.operation;
    const target = head.target_size;
    if (!operation || target === undefined) {
      throw new Error(`Invalid mutation journal for ${head.id}`);
    }
    await this.applySizeMutation(head, operation, target);
    const complete: FileHead = {
      id: head.id,
      physical_id: head.physical_id,
      size: target,
      state: "complete",
      created_at: head.created_at,
      checksum: null,
    };
    await putHead(complete);
    return complete;
  }

  private async mutateSize(
    head: FileHead,
    operation: "grow" | "shrink",
    target: number,
  ): Promise<void> {
    const journal: FileHead = {
      ...head,
      state: "mutating",
      operation,
      target_size: target,
      checksum: null,
    };
    await putHead(journal);
    await this.recoverHead(journal);
  }

  private async applySizeMutation(
    head: FileHead,
    operation: "grow" | "shrink",
    target: number,
  ): Promise<void> {
    if (operation === "grow") {
      for (let extent = 0; extent < extentCount(target); extent += 1) {
        const required = extentLength(target, extent);
        const current = await readPhysicalExtent(head.physical_id, extent);
        if (current?.byteLength === required) continue;
        if (current && current.byteLength > required) {
          throw new Error(
            `Grow found oversized extent ${extent} for ${head.id}`,
          );
        }
        const value = new Uint8Array(required);
        if (current) value.set(new Uint8Array(current));
        await putPhysicalExtent(head.physical_id, extent, value.buffer);
      }
      return;
    }

    const nextCount = extentCount(target);
    if (nextCount) {
      const last = nextCount - 1;
      const required = extentLength(target, last);
      const current = await readPhysicalExtent(head.physical_id, last);
      if (!current || current.byteLength < required) {
        throw new Error(
          `Missing shrink boundary extent ${last} for ${head.id}`,
        );
      }
      if (current.byteLength !== required) {
        await putPhysicalExtent(
          head.physical_id,
          last,
          current.slice(0, required),
        );
      }
    }
    for (
      let start = nextCount;
      start < extentCount(head.size);
      start += MAX_EXTENTS_PER_TRANSACTION
    ) {
      const end = Math.min(
        extentCount(head.size),
        start + MAX_EXTENTS_PER_TRANSACTION,
      );
      await runTransaction(STORES.FILES, "readwrite", (tx) => {
        const store = tx.objectStore(STORES.FILES);
        for (let extent = start; extent < end; extent += 1) {
          store.delete([head.physical_id, extent]);
        }
      });
    }
  }

  private async publishGeneration(
    id: string,
    expectedSize: number,
    fill: (writer: GenerationWriter) => Promise<void>,
    checksum: string | null = null,
  ): Promise<void> {
    const previous = await this.recoverHead(await readHead(id));
    const nextPhysicalId = physicalId(id);
    const writer = new GenerationWriter(nextPhysicalId, expectedSize);
    try {
      await fill(writer);
      await writer.finish();
      const next: FileHead = {
        id,
        physical_id: nextPhysicalId,
        size: expectedSize,
        state: "complete",
        created_at: Date.now(),
        checksum,
      };
      await runTransaction(STORES.FILE_HEADS, "readwrite", (tx) => {
        tx.objectStore(STORES.FILE_HEADS).put(next);
      });
    } catch (error) {
      await deletePhysical(nextPhysicalId, extentCount(expectedSize));
      throw error;
    }
    if (previous) {
      await deletePhysical(previous.physical_id, extentCount(previous.size));
    }
  }
}

export class ExtentFileCursor {
  constructor(
    private readonly files: ExtentFileStore,
    readonly id: string,
    private offset: number,
  ) {}

  tell(): number {
    return this.offset;
  }

  seek(offset: number): void {
    assertSize(offset, "offset");
    this.offset = offset;
  }

  async read(length: number): Promise<ArrayBuffer> {
    const value = await this.files.read(this.id, this.offset, length);
    this.offset += value.byteLength;
    return value;
  }

  async write(value: ArrayBufferView): Promise<void> {
    await this.files.write(this.id, this.offset, value);
    this.offset += value.byteLength;
  }
}

class GenerationWriter {
  private extent = 0;
  private total = 0;
  private buffered = new Uint8Array(EXTENT_SIZE);
  private bufferedLength = 0;

  constructor(
    private readonly physicalId: string,
    private readonly expectedSize: number,
  ) {}

  async write(buffer: ArrayBuffer): Promise<void> {
    const source = new Uint8Array(buffer);
    let read = 0;
    while (read < source.length) {
      const amount = Math.min(
        source.length - read,
        EXTENT_SIZE - this.bufferedLength,
      );
      this.buffered.set(
        source.subarray(read, read + amount),
        this.bufferedLength,
      );
      this.bufferedLength += amount;
      this.total += amount;
      read += amount;
      if (this.total > this.expectedSize) {
        throw new RangeError("File source exceeded expected size");
      }
      if (this.bufferedLength === EXTENT_SIZE) await this.flush();
    }
  }

  async finish(): Promise<void> {
    if (this.total !== this.expectedSize) {
      throw new RangeError(
        `File source length ${this.total} did not match ${this.expectedSize}`,
      );
    }
    if (this.bufferedLength) await this.flush();
  }

  private async flush(): Promise<void> {
    const value = this.buffered.buffer.slice(0, this.bufferedLength);
    await putPhysicalExtent(this.physicalId, this.extent, value);
    this.extent += 1;
    this.buffered = new Uint8Array(EXTENT_SIZE);
    this.bufferedLength = 0;
  }
}

export const extentFiles = new ExtentFileStore();
