import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

export interface GcDirectoryStat {
  isFile: boolean;
  mtimeMs: number;
}

/**
 * Directory GC I/O. BlobStore injects the real filesystem; tests pause after
 * the first aged stat so create/drop/touch can be inserted before the confirm
 * stat that decides unlink.
 */
export interface GcDirectoryIo {
  readdir(directory: string): Promise<string[]>;
  stat(absolutePath: string): Promise<GcDirectoryStat>;
  unlink(absolutePath: string): Promise<void>;
}

export type GcSerialize = (
  name: string,
  operation: () => Promise<void>,
) => Promise<void>;

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

export function gcCutoffMs(nowMs: number, retentionMs: number): number {
  if (!Number.isFinite(nowMs) || !Number.isFinite(retentionMs)) {
    throw new Error("GC cutoff requires finite timestamps");
  }
  return nowMs - retentionMs;
}

/** Inclusive: a file whose mtime equals the cutoff is reclaimable. */
export function isReclaimableMtime(mtimeMs: number, cutoffMs: number): boolean {
  return mtimeMs <= cutoffMs;
}

export function createFsGcIo(): GcDirectoryIo {
  return {
    readdir,
    async stat(absolutePath) {
      const info = await stat(absolutePath);
      return { isFile: info.isFile(), mtimeMs: info.mtimeMs };
    },
    async unlink(absolutePath) {
      await rm(absolutePath, { force: true });
    },
  };
}

async function reclaimIfStillAged(
  target: string,
  cutoffMs: number,
  io: GcDirectoryIo,
): Promise<void> {
  const first = await io.stat(target);
  if (!first.isFile || !isReclaimableMtime(first.mtimeMs, cutoffMs)) return;
  const confirmed = await io.stat(target);
  if (!confirmed.isFile || !isReclaimableMtime(confirmed.mtimeMs, cutoffMs)) {
    return;
  }
  await io.unlink(target);
}

/**
 * Mtime GC of one staging or trash directory. Callers must not point this at
 * `objects/`: a live-key comparison cannot tell a crash leftover from an
 * in-flight publish.
 *
 * Unlink is compare-and-delete: a second stat must still see an aged file.
 * A recreate or mtime touch of the same name after the first snapshot is kept.
 * Missing names are concurrent commit/discard. Other I/O errors surface.
 */
export async function gcAgedDirectory(
  directory: string,
  cutoffMs: number,
  io: GcDirectoryIo,
  serialize?: GcSerialize,
): Promise<void> {
  let names: string[] = [];
  try {
    names = await io.readdir(directory);
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
  const run = serialize ?? ((_name, operation) => operation());
  for (const name of names) {
    const target = path.join(directory, name);
    await run(name, async () => {
      try {
        await reclaimIfStillAged(target, cutoffMs, io);
      } catch (error) {
        if (isEnoent(error)) return;
        throw error;
      }
    });
  }
}
