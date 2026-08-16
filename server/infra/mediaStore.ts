import { createReadStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

export type MediaObjectKind = "audio" | "cover";

export interface MediaObjectStore {
  stagePath(kind: MediaObjectKind, id: string): string;
  publish(kind: MediaObjectKind, id: string): Promise<string>;
  resolve(relativePath: string): string;
  stream(
    relativePath: string,
    range?: { start: number; end: number },
  ): Promise<{ size: number; body: ReadableStream<Uint8Array> }>;
  size(relativePath: string): Promise<number>;
  trash(relativePath: string | null | undefined): Promise<void>;
  reconcile(): Promise<void>;
}

/**
 * File mechanism with every repository path injected. The DB owns object
 * identity; files are staging/trash state under the caller-provided root.
 */
export function createMediaObjectStore(root: string): MediaObjectStore {
  const objectRoot = path.resolve(root);

  function namespace(kind: MediaObjectKind): string {
    return kind;
  }

  function absolute(kind: MediaObjectKind, id: string): string {
    const safe = path.posix
      .normalize(String(id).replaceAll("\\", "/"))
      .replace(/^\.\.?\/?/, "");
    if (
      safe === ".." ||
      safe.startsWith("../") ||
      path.posix.isAbsolute(safe) ||
      /^[A-Za-z]:\//.test(safe) ||
      !/^[A-Za-z0-9._-]+$/.test(safe)
    ) {
      throw new Error("Invalid media object id");
    }
    return path.join(objectRoot, namespace(kind), safe);
  }

  function stagePath(kind: MediaObjectKind, id: string): string {
    return `${absolute(kind, id)}.partial`;
  }

  async function publish(
    kind: MediaObjectKind,
    id: string,
  ): Promise<string> {
    const staged = stagePath(kind, id);
    const final = absolute(kind, id);
    await mkdir(path.dirname(final), { recursive: true });
    // A crashed publication can leave an orphan final object; DB rows are the
    // authority, so replacing it is the correct compensation everywhere.
    await rm(final, { force: true }).catch(() => undefined);
    await rename(staged, final);
    return path.posix.join("objects", "media", namespace(kind), id);
  }

  function resolve(relativePath: string): string {
    const normalized = path.posix.normalize(
      relativePath.replaceAll("\\", "/"),
    );
    if (
      normalized === ".." ||
      normalized.startsWith("../") ||
      path.posix.isAbsolute(normalized) ||
      /^[A-Za-z]:\//.test(normalized) ||
      !normalized.startsWith("objects/media/")
    ) {
      throw new Error("Invalid media object path");
    }
    // publish() returns a dataRoot-relative path. The object root itself is
    // <dataRoot>/objects/media, so dropping the common "objects/media" prefix
    // and joining onto the object root resolves it without new path owners.
    return path.join(objectRoot, ...normalized.split("/").slice(2));
  }

  async function stream(
    relativePath: string,
    range?: { start: number; end: number },
  ): Promise<{ size: number; body: ReadableStream<Uint8Array> }> {
    const absolutePath = resolve(relativePath);
    const info = await stat(absolutePath);
    return {
      size: info.size,
      body: Readable.toWeb(
        createReadStream(absolutePath, range),
      ) as ReadableStream<Uint8Array>,
    };
  }

  async function size(relativePath: string): Promise<number> {
    return (await stat(resolve(relativePath))).size;
  }

  async function trash(
    relativePath: string | null | undefined,
  ): Promise<void> {
    if (!relativePath) return;
    const source = resolve(relativePath);
    const trash = path.join(
      objectRoot,
      ".trash",
      `${path.basename(source)}-${Date.now()}`,
    );
    try {
      await mkdir(path.dirname(trash), { recursive: true });
      await rename(source, trash);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return;
    }
    setTimeout(() => {
      void rm(trash, { force: true }).catch(() => undefined);
    }, 60_000).unref();
  }

  async function reconcile(): Promise<void> {
    try {
      await mkdir(objectRoot, { recursive: true });
    } catch {
      return;
    }
    for (const kind of ["audio", "cover"] as const) {
      const directory = path.join(objectRoot, kind);
      let entries: string[];
      try {
        entries = await readdir(directory);
      } catch {
        continue;
      }
      for (const name of entries.slice(0, 200)) {
        if (!name.endsWith(".partial")) continue;
        const target = path.join(directory, name);
        try {
          const info = await stat(target);
          if (Date.now() - info.mtimeMs > 60 * 60_000) {
            await rm(target, { force: true });
          }
        } catch {
          // A concurrently committed file is no longer partial.
        }
      }
    }
  }

  return { stagePath, publish, resolve, stream, size, trash, reconcile };
}
