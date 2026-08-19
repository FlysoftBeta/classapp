import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

export interface GcDirectoryStat {
  isFile: boolean;
  mtimeMs: number;
}

/**
 * Directory GC I/O. BlobStore injects the real filesystem; tests pause between
 * stat and unlink so create/drop/touch can be inserted at the TOCTOU window.
 */
export interface GcDirectoryIo {
  readdir(directory: string): Promise<string[]>;
  stat(absolutePath: string): Promise<GcDirectoryStat>;
  unlink(absolutePath: string): Promise<void>;
}

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

/**
 * Mtime GC of one staging or trash directory. Callers must not point this at
 * `objects/`: a live-key comparison cannot tell a crash leftover from an
 * in-flight publish.
 *
 * The current loop unlinks from the first stat without a blob-id lock or a
 * second stat. A recreate or mtime touch of the same name can therefore lose
 * newer bytes. That is a gap, not an accepted invariant.
 */
export async function gcAgedDirectory(
  directory: string,
  cutoffMs: number,
  io: GcDirectoryIo,
): Promise<void> {
  let names: string[] = [];
  try {
    names = await io.readdir(directory);
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
  for (const name of names) {
    const target = path.join(directory, name);
    try {
      const info = await io.stat(target);
      if (!info.isFile) continue;
      if (isReclaimableMtime(info.mtimeMs, cutoffMs)) {
        await io.unlink(target);
      }
    } catch {
      // Concurrent commit/discard may remove the name; other unlink failures
      // are also swallowed by the current mechanism.
    }
  }
}
