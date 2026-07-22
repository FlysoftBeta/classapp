import crypto from "node:crypto";
import type { Database } from "better-sqlite3";
import type { User } from "@/shared/types/api";
import { ClientBusyError, createTomatoClientPool } from "@/lib/tomato";
import type { SearchBook } from "@/lib/tomato";
import { createArticleService } from "./articlesService";

export interface NetworkArticleResult {
  source: "tomato";
  book_id: string;
  title: string;
  author: string | null;
  abstract: string;
  word_count: number | null;
}

export interface ArticleImportTask {
  id: string;
  source: "tomato";
  user_id: string;
  book_id: string;
  title: string;
  status: "queued" | "downloading" | "completed" | "failed";
  progress: number;
  total: number;
  eta_ms: number;
  article_id: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

function toResult(book: SearchBook): NetworkArticleResult {
  return {
    source: "tomato",
    book_id: book.book_id,
    title: book.book_name?.trim() || book.book_id,
    author: book.author?.trim() || null,
    abstract: book.book_abstract?.trim() || "",
    word_count: typeof book.word_count === "number" ? book.word_count : null,
  };
}

const pool = createTomatoClientPool(
  Number.parseInt(process.env.TOMATO_CLIENT_POOL_SIZE ?? "2", 10) || 2,
  { timeoutMs: 30_000, retries: 4 },
);

export class ArticleImportService {
  private readonly tasks = new Map<string, ArticleImportTask>();

  constructor(private readonly db: Database) {}

  async search(
    userId: string,
    query: string,
  ): Promise<
    | { status: "ready"; results: NetworkArticleResult[] }
    | { status: "busy"; retry_after_ms: number; ready_at: number }
  > {
    try {
      const books = await pool.runInteractive(userId, "search", (client) =>
        client.searchBooks(query, { pages: 1, timeoutMs: 45_000 }),
      );
      return { status: "ready", results: books.map(toResult) };
    } catch (error) {
      if (error instanceof ClientBusyError) {
        return {
          status: "busy",
          retry_after_ms: error.retryAfterMs,
          ready_at: error.readyAt,
        };
      }
      throw error;
    }
  }

  start(user: User, bookId: string, titleHint = ""): ArticleImportTask {
    this.prune();
    const existing = [...this.tasks.values()].find(
      (task) =>
        task.user_id === user.id &&
        task.book_id === bookId &&
        (task.status === "queued" || task.status === "downloading"),
    );
    if (existing) return existing;
    const now = Date.now();
    const task: ArticleImportTask = {
      id: crypto.randomUUID(),
      source: "tomato",
      user_id: user.id,
      book_id: bookId,
      title: titleHint.trim() || bookId,
      status: "queued",
      progress: 0,
      total: 0,
      eta_ms: 0,
      article_id: null,
      error: null,
      created_at: now,
      updated_at: now,
    };
    this.tasks.set(task.id, task);
    void this.run(user, task);
    return task;
  }

  list(userId: string): ArticleImportTask[] {
    return [...this.tasks.values()]
      .filter((task) => task.user_id === userId)
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, 50);
  }

  private async run(user: User, task: ArticleImportTask): Promise<void> {
    try {
      task.status = "downloading";
      task.updated_at = Date.now();
      const catalog = await pool.runQueued("download", (client) =>
        client.getCatalog(task.book_id),
      );
      task.title = catalog.title;
      task.total = catalog.chapters.length;
      const parts: string[] = [];
      for (const chapter of catalog.chapters) {
        const content = await pool.runQueued("download", (client) =>
          client.getChapter(chapter.chapterId),
        );
        parts.push(`${content.title}\n\n${content.text}`);
        task.progress += 1;
        task.eta_ms = Math.max(0, task.total - task.progress) * 500;
        task.updated_at = Date.now();
      }
      const header = `${catalog.title}${catalog.author ? `\n作者：${catalog.author}` : ""}`;
      const { article } = createArticleService(this.db).createText(user, {
        title: catalog.title,
        content: `${header}\n\n${parts.join("\n\n")}`,
      });
      task.status = "completed";
      task.article_id = article.id;
      task.eta_ms = 0;
      task.updated_at = Date.now();
    } catch (error) {
      task.status = "failed";
      task.error = error instanceof Error ? error.message : String(error);
      task.eta_ms = 0;
      task.updated_at = Date.now();
    }
  }

  private prune(): void {
    const cutoff = Date.now() - 24 * 60 * 60_000;
    for (const [id, task] of this.tasks) {
      if (
        task.updated_at < cutoff &&
        (task.status === "completed" || task.status === "failed")
      ) {
        this.tasks.delete(id);
      }
    }
  }
}

let singleton: ArticleImportService | null = null;
export function createArticleImportService(db: Database): ArticleImportService {
  singleton ??= new ArticleImportService(db);
  return singleton;
}
