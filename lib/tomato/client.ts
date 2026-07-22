import { load } from "cheerio";
import { getCompleteChapter } from "./chapter";
import { decodeReaderText } from "./decode";
import { TomatoError } from "./errors";
import { BASE_URL, getHtml } from "./http";
import { ClientBusyError } from "./errors";
import type {
  Catalog,
  Chapter,
  ChapterContent,
  ClientOptions,
  CooldownLayer,
  SearchBook,
  SearchOptions,
} from "./types";
import { searchBooksWithBrowser } from "./search";

interface CooldownState {
  intervalMs: number;
  lastStartedAt: number;
  inFlight: boolean;
  pending: number;
  tail: Promise<void>;
}

/** Shared abstraction for externally rate-limited clients. */
export abstract class Client {
  private readonly cooldowns: Record<CooldownLayer, CooldownState>;

  protected constructor(options: ClientOptions = {}) {
    this.cooldowns = {
      search: this.createCooldown(
        Math.max(5_000, options.searchCooldownMs ?? 5_000),
      ),
      download: this.createCooldown(
        Math.max(500, options.downloadCooldownMs ?? 500),
      ),
    };
  }

  cooldownMs(layer: CooldownLayer): number {
    return this.cooldowns[layer].intervalMs;
  }

  availableAt(layer: CooldownLayer): number {
    const state = this.cooldowns[layer];
    return state.inFlight || state.pending > 0
      ? Number.POSITIVE_INFINITY
      : state.lastStartedAt + state.intervalMs;
  }

  busy(layer: CooldownLayer): boolean {
    const state = this.cooldowns[layer];
    return (
      state.inFlight ||
      state.pending > 0 ||
      Date.now() < this.availableAt(layer)
    );
  }

  protected async throttled<T>(
    layer: CooldownLayer,
    operation: () => Promise<T>,
  ): Promise<T> {
    const state = this.cooldowns[layer];
    state.pending += 1;
    const previous = state.tail;
    let release!: () => void;
    state.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const waitMs = Math.max(
        0,
        state.lastStartedAt + state.intervalMs - Date.now(),
      );
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      state.inFlight = true;
      state.lastStartedAt = Date.now();
      return await operation();
    } finally {
      state.inFlight = false;
      state.pending -= 1;
      release();
    }
  }

  /** Used by pools for a fail-fast interactive request. */
  assertReady(layer: CooldownLayer, now = Date.now()): void {
    const state = this.cooldowns[layer];
    const readyAt = this.availableAt(layer);
    if (state.inFlight || now < readyAt) {
      const finiteReadyAt = Number.isFinite(readyAt)
        ? readyAt
        : now + state.intervalMs;
      throw new ClientBusyError(
        Math.max(1, finiteReadyAt - now),
        finiteReadyAt,
      );
    }
  }

  private createCooldown(intervalMs: number): CooldownState {
    return {
      intervalMs,
      lastStartedAt: 0,
      inFlight: false,
      pending: 0,
      tail: Promise.resolve(),
    };
  }
}

function cleanReaderText(value: string): string {
  return decodeReaderText(value.replaceAll("\u00a0", " ").trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseId(value: string, kind: "book" | "chapter"): string {
  const route = kind === "book" ? "page" : "reader";
  const match = value.match(new RegExp(`/${route}/(\\d+)`));
  if (match) return match[1];
  if (/^\d{10,}$/.test(value)) return value;
  throw new TomatoError(
    `无法从 ${JSON.stringify(value)} 解析${kind === "book" ? "书籍" : "章节"} ID`,
  );
}

function readAuthor(scripts: string[]): string | null {
  for (const script of scripts) {
    try {
      const data: unknown = JSON.parse(script);
      if (!isRecord(data) || !Array.isArray(data.author)) continue;
      const first = data.author[0];
      if (isRecord(first) && typeof first.name === "string") {
        return first.name;
      }
    } catch {
      // Ignore unrelated or malformed JSON-LD blocks.
    }
  }
  return null;
}

export class TomatoClient extends Client {
  readonly options: ClientOptions;

  constructor(options: ClientOptions = {}) {
    super(options);
    this.options = options;
  }

  async searchBooks(
    query: string,
    options: SearchOptions = {},
  ): Promise<SearchBook[]> {
    return this.throttled("search", () =>
      searchBooksWithBrowser(query, options),
    );
  }

  async getCatalog(book: string): Promise<Catalog> {
    const bookId = parseId(book, "book");
    const url = `${BASE_URL}/page/${bookId}`;
    const $ = load(
      await this.throttled("download", () => getHtml(url, this.options)),
    );
    const title = cleanReaderText($("h1").first().text()) || bookId;
    const author = readAuthor(
      $('script[type="application/ld+json"]')
        .toArray()
        .map((element) => $(element).text()),
    );

    const chapters: Chapter[] = [];
    const seen = new Set<string>();
    $("div.chapter a[href^='/reader/']").each((_index, element) => {
      const href = $(element).attr("href") ?? "";
      const match = href.match(/\/reader\/(\d+)/);
      if (!match || seen.has(match[1])) return;
      const chapterId = match[1];
      seen.add(chapterId);
      chapters.push({
        index: chapters.length + 1,
        chapterId,
        title: cleanReaderText($(element).text()),
        url: `${BASE_URL}/reader/${chapterId}`,
      });
    });

    if (chapters.length === 0) {
      throw new TomatoError(
        `没有在 ${url} 找到目录；页面结构可能已变更或触发了验证`,
      );
    }
    return { bookId, title, author, chapters };
  }

  async getChapter(chapter: string): Promise<ChapterContent> {
    const chapterId = parseId(chapter, "chapter");
    return this.throttled("download", () =>
      getCompleteChapter(chapterId, this.options),
    );
  }
}
