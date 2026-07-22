import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { TomatoClient } from "./client";
import { TomatoError } from "./errors";
import type {
  Catalog,
  DownloadFailure,
  DownloadOptions,
  DownloadResult,
} from "./types";

function safeFilename(value: string, limit = 100): string {
  const cleaned = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[ .]+$/g, "")
    .trim();
  return (cleaned || "untitled").slice(0, limit);
}

async function atomicWrite(filePath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.part`;
  await writeFile(temporaryPath, contents, "utf8");
  await rename(temporaryPath, filePath);
}

async function isCompletedChapter(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).size > 20;
  } catch {
    return false;
  }
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function catalogJson(catalog: Catalog): string {
  return JSON.stringify(
    {
      bookId: catalog.bookId,
      title: catalog.title,
      author: catalog.author,
      chapterCount: catalog.chapters.length,
      chapters: catalog.chapters,
    },
    null,
    2,
  );
}

export async function downloadBook(
  book: string,
  options: DownloadOptions,
): Promise<DownloadResult> {
  if (!options.outputDir) {
    throw new TomatoError("downloadBook 需要 outputDir");
  }
  const client = new TomatoClient(options);
  const catalog = await client.getCatalog(book);
  const start = Math.max(1, Math.floor(options.start ?? 1));
  const end = Math.min(
    Math.floor(options.end ?? catalog.chapters.length),
    catalog.chapters.length,
  );
  const selected = catalog.chapters.slice(start - 1, end);
  if (selected.length === 0) throw new TomatoError("章节范围为空");

  const rootDir = path.resolve(
    options.outputDir,
    `${safeFilename(catalog.title)}_${catalog.bookId}`,
  );
  const chapterDir = path.join(rootDir, "chapters");
  await mkdir(chapterDir, { recursive: true });
  await atomicWrite(
    path.join(rootDir, "catalog.json"),
    `${catalogJson(catalog)}\n`,
  );

  const failures: DownloadFailure[] = [];
  const delayMs = Math.max(0, options.delayMs ?? 0);
  for (let position = 0; position < selected.length; position += 1) {
    options.signal?.throwIfAborted();
    const chapter = selected[position];
    const chapterPath = path.join(
      chapterDir,
      `${String(chapter.index).padStart(5, "0")}_${chapter.chapterId}.txt`,
    );
    if (!options.overwrite && (await isCompletedChapter(chapterPath))) {
      options.onProgress?.({
        position: position + 1,
        total: selected.length,
        chapter,
        status: "skipped",
      });
      continue;
    }
    try {
      const content = await client.getChapter(chapter.chapterId);
      await atomicWrite(chapterPath, `${content.title}\n\n${content.text}\n`);
      options.onProgress?.({
        position: position + 1,
        total: selected.length,
        chapter,
        status: "downloaded",
        source: content.source,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ chapter, error: message });
      options.onProgress?.({
        position: position + 1,
        total: selected.length,
        chapter,
        status: "failed",
        error: message,
      });
    }
    if (position + 1 < selected.length) {
      await delay(
        Math.round(delayMs * (1 + Math.random() * 0.35)),
        options.signal,
      );
    }
  }

  const combined: string[] = [];
  let missingCount = 0;
  for (const chapter of catalog.chapters) {
    const chapterPath = path.join(
      chapterDir,
      `${String(chapter.index).padStart(5, "0")}_${chapter.chapterId}.txt`,
    );
    try {
      combined.push((await readFile(chapterPath, "utf8")).trimEnd());
    } catch {
      missingCount += 1;
    }
  }

  let combinedPath: string | null = null;
  if (combined.length > 0) {
    combinedPath = path.join(rootDir, `${safeFilename(catalog.title)}.txt`);
    const header = `${catalog.title}${catalog.author ? `\n作者：${catalog.author}` : ""}`;
    await atomicWrite(combinedPath, `${header}\n\n${combined.join("\n\n")}\n`);
  }

  const failuresPath = path.join(rootDir, "failures.json");
  if (failures.length > 0) {
    await atomicWrite(failuresPath, `${JSON.stringify(failures, null, 2)}\n`);
  } else {
    await rm(failuresPath, { force: true });
  }

  return {
    catalog,
    rootDir,
    combinedPath,
    missingCount,
    failures,
  };
}
