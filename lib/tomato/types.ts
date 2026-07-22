export interface Chapter {
  index: number;
  chapterId: string;
  title: string;
  url: string;
}

export interface Catalog {
  bookId: string;
  title: string;
  author: string | null;
  chapters: Chapter[];
}

export interface ChapterContent {
  chapterId: string;
  title: string;
  paragraphs: string[];
  text: string;
  /** Backend that supplied the validated, non-preview body. */
  source: string;
}

export interface ChapterMirrorBackend {
  /** Stable diagnostic name; never contains credentials. */
  name: string;
  /** URL template. `{chapterId}` is replaced with the numeric chapter ID. */
  url: string;
  /** Per-request timeout. Mirror requests deliberately fail faster than SSR. */
  timeoutMs?: number;
  /** Optional fixed headers required by a public proxy. */
  headers?: Readonly<Record<string, string>>;
  /** Minimum interval between requests sent to this backend. */
  cooldownMs?: number;
}

export interface ChapterProviderAttempt {
  source: string;
  status: "success" | "failed" | "skipped";
  error?: string;
}

export interface SearchBook extends Record<string, unknown> {
  book_id: string;
  book_name?: string;
  author?: string;
  book_abstract?: string;
  category?: string;
  first_chapter_id?: string;
  last_chapter_id?: string;
  last_chapter_title?: string;
  word_count?: number;
  read_count?: number;
}

export interface HttpOptions {
  timeoutMs?: number;
  retries?: number;
  userAgent?: string;
  signal?: AbortSignal;
}

export interface SearchOptions {
  pages?: number;
  humanize?: boolean;
  timeoutMs?: number;
}

export type CooldownLayer = "search" | "download";

export interface ClientOptions extends HttpOptions {
  searchCooldownMs?: number;
  downloadCooldownMs?: number;
  /** Override the built-in public full-text mirror list; [] disables mirrors. */
  chapterMirrors?: readonly ChapterMirrorBackend[];
  /**
   * Cookie header for the official full API and browser renderer. It is never
   * included in errors or provider diagnostics.
   */
  fanqieCookie?: string;
  /** Try the official `/api/reader/full` endpoint even without a cookie. */
  tryAnonymousFullApi?: boolean;
  /** Render a chapter in pooled Chromium after direct official APIs fail. */
  browserChapterFallback?: boolean;
  /** Receives redacted provider health information. */
  onChapterProviderAttempt?: (attempt: ChapterProviderAttempt) => void;
}

export interface DownloadProgress {
  position: number;
  total: number;
  chapter: Chapter;
  status: "downloaded" | "skipped" | "failed";
  source?: string;
  error?: string;
}

export interface DownloadOptions extends ClientOptions {
  outputDir: string;
  start?: number;
  end?: number;
  delayMs?: number;
  overwrite?: boolean;
  onProgress?: (progress: DownloadProgress) => void;
}

export interface DownloadFailure {
  chapter: Chapter;
  error: string;
}

export interface DownloadResult {
  catalog: Catalog;
  rootDir: string;
  combinedPath: string | null;
  missingCount: number;
  failures: DownloadFailure[];
}
