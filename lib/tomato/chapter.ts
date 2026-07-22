import { load } from "cheerio";
import type { Page } from "playwright";
import { getDefaultBrowserPool } from "./browser";
import { decodeReaderText } from "./decode";
import { TomatoError } from "./errors";
import { BASE_URL, getHtml, getText } from "./http";
import type {
  ChapterContent,
  ChapterMirrorBackend,
  ChapterProviderAttempt,
  ClientOptions,
} from "./types";

const PREVIEW_MARKERS = [
  "会员登录后，可网页畅读全文",
  "会员登录后可网页畅读全文",
  "会员登录后，可在网页畅读全文",
  "扫码下载APP免费读，SVIP网页畅读",
  "打开番茄小说APP阅读全文",
  "打开番茄小说App阅读全文",
  "下载番茄小说APP",
  "前往番茄小说APP",
  "去番茄小说阅读",
];

const CIRCUIT_FAILURES = 2;
const CIRCUIT_COOLDOWN_MS = 2 * 60_000;

interface CircuitState {
  failures: number;
  retryAt: number;
}

interface ParsedBody {
  title: string | null;
  paragraphs: string[];
  expectedParagraphs: number | null;
  preview: boolean;
}

const mirrorCircuits = new Map<string, CircuitState>();
const mirrorNextRequestAt = new Map<string, number>();

/**
 * Public mirrors observed in maintained downloaders. They are deliberately
 * ordered by current health and are never treated as authoritative.
 */
export const DEFAULT_CHAPTER_MIRRORS: readonly ChapterMirrorBackend[] = [
  {
    name: "fqdt-raw-full",
    url: "http://101.35.133.34:5000/api/raw_full?item_id={chapterId}",
    timeoutMs: 6_000,
  },
  {
    name: "fanqietc-content",
    url: "https://api.fanqietc.com/proxy?api=default&action=content&item_id={chapterId}",
    timeoutMs: 8_000,
    cooldownMs: 1_100,
    headers: {
      "X-API-Token": "fqtc_7nKp2mQ8xR4vL6wT1yZ3bC5dF0hJ8aE9uI3kM7",
      Origin: "https://fanqietc.com",
      Referer: "https://fanqietc.com/",
    },
  },
  {
    name: "fqdt-content",
    url: "http://101.35.133.34:5000/api/content?tab=%E5%B0%8F%E8%AF%B4&item_id={chapterId}",
    timeoutMs: 6_000,
  },
  {
    name: "sjmyzq-raw-full",
    url: "https://tt.sjmyzq.cn/api/raw_full?item_id={chapterId}",
    timeoutMs: 6_000,
  },
  {
    name: "20071006-content",
    url: "https://20071006.xyz/api/content?item_id={chapterId}&tab=%E5%B0%8F%E8%AF%B4",
    timeoutMs: 6_000,
  },
];

function clean(value: string): string {
  return decodeReaderText(value.replaceAll("\u00a0", " ").trim());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function report(options: ClientOptions, attempt: ChapterProviderAttempt): void {
  options.onChapterProviderAttempt?.(attempt);
}

function containsPreviewMarker(value: string): boolean {
  return PREVIEW_MARKERS.some((marker) => value.includes(marker));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function findContentRecord(
  value: unknown,
  depth = 0,
): Record<string, unknown> | null {
  if (depth > 5) return null;
  const record = asRecord(value);
  if (!record) return null;
  if (typeof record.content === "string" && record.content.trim()) {
    return record;
  }
  for (const key of ["data", "result", "chapter", "item_data"]) {
    if (!(key in record)) continue;
    const found = findContentRecord(record[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function firstString(
  record: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    if (typeof record[key] === "string" && record[key].trim()) {
      return clean(record[key]);
    }
  }
  return null;
}

function firstNumber(
  record: Record<string, unknown>,
  keys: string[],
): number | null {
  for (const key of keys) {
    const value = Number(record[key]);
    if (Number.isInteger(value) && value > 0) return value;
  }
  return null;
}

function contentToParagraphs(content: string): string[] {
  const $ = load(`<main id="tomato-content">${content}</main>`);
  const paragraphElements = $("#tomato-content p").toArray();
  const values =
    paragraphElements.length > 0
      ? paragraphElements.map((element) => $(element).text())
      : $("#tomato-content")
          .text()
          .split(/\r?\n+/);
  return values.map(clean).filter(Boolean);
}

function parseJsonBody(body: string): ParsedBody {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch (error) {
    throw new TomatoError("全文后端返回的不是合法 JSON", { cause: error });
  }
  const outer = asRecord(payload);
  if (outer && (outer.need_pay === true || outer.code === 403)) {
    throw new TomatoError("全文后端要求付费或登录");
  }
  const record = findContentRecord(payload);
  if (!record) throw new TomatoError("全文后端没有返回 content");
  if (record.need_pay === true) throw new TomatoError("全文后端未解锁该章节");
  const content = String(record.content);
  return {
    title: firstString(record, [
      "title",
      "chapter_title",
      "chapterTitle",
      "name",
    ]),
    paragraphs: contentToParagraphs(content),
    expectedParagraphs:
      firstNumber(record, ["paragraphs_num", "paragraphsNum"]) ??
      (outer ? firstNumber(outer, ["paragraphs_num", "paragraphsNum"]) : null),
    preview: containsPreviewMarker(content),
  };
}

function parseSsrBody(body: string): ParsedBody {
  const $ = load(body);
  const paragraphs = $("div.muye-reader-content p")
    .toArray()
    .map((element) => clean($(element).text()))
    .filter(Boolean);
  const warningText = [
    $(".muye-to-vip").text(),
    $(".muye-to-fanqie").text(),
    $(".reader-unlock").text(),
    $(".reader-lock-overlay").text(),
  ].join("\n");
  return {
    title: clean($("h1.muye-reader-title").first().text()) || null,
    paragraphs,
    expectedParagraphs: null,
    preview:
      $(".muye-to-vip, .muye-to-fanqie, .reader-unlock, .reader-lock-overlay")
        .length > 0 ||
      containsPreviewMarker(`${warningText}\n${$("body").text()}`),
  };
}

function validateBody(body: ParsedBody, source: string): ParsedBody {
  if (body.paragraphs.length === 0) {
    throw new TomatoError(`${source} 没有返回正文段落`);
  }
  if (body.preview) {
    throw new TomatoError(`${source} 只返回了网页预览`);
  }
  if (
    body.expectedParagraphs !== null &&
    body.paragraphs.length < body.expectedParagraphs
  ) {
    throw new TomatoError(
      `${source} 声明 ${body.expectedParagraphs} 段，但只返回 ${body.paragraphs.length} 段`,
    );
  }
  return body;
}

function toChapterContent(
  chapterId: string,
  fallbackTitle: string,
  source: string,
  body: ParsedBody,
): ChapterContent {
  return {
    chapterId,
    title: body.title || fallbackTitle || chapterId,
    paragraphs: body.paragraphs,
    text: body.paragraphs.join("\n"),
    source,
  };
}

function cookieHeaderToCookies(value: string): Array<{
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
}> {
  return value
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part) => {
      const separator = part.indexOf("=");
      if (separator <= 0) return [];
      return [
        {
          name: part.slice(0, separator).trim(),
          value: part.slice(separator + 1).trim(),
          domain: ".fanqienovel.com",
          path: "/",
          secure: true,
        },
      ];
    });
}

async function browserBody(
  page: Page,
  chapterId: string,
  options: ClientOptions,
): Promise<ParsedBody> {
  if (options.fanqieCookie) {
    await page
      .context()
      .addCookies(cookieHeaderToCookies(options.fanqieCookie));
  }
  let apiBody: Promise<string | null> | null = null;
  page.on("response", (response) => {
    if (!response.url().includes("/api/reader/full") || apiBody) return;
    apiBody = response.text().catch(() => null);
  });
  await page.goto(`${BASE_URL}/reader/${chapterId}`, {
    waitUntil: "domcontentloaded",
    timeout: options.timeoutMs ?? 20_000,
  });
  await page
    .locator("div.muye-reader-content")
    .first()
    .waitFor({ state: "attached", timeout: options.timeoutMs ?? 20_000 });
  await page.waitForTimeout(500);
  const captured = apiBody ? await apiBody : null;
  if (captured) {
    try {
      return validateBody(parseJsonBody(captured), "official-browser-api");
    } catch {
      // The DOM can still be complete when the intercepted response is absent
      // or uses a shape unknown to this version.
    }
  }
  const title = clean(
    (await page.locator("h1.muye-reader-title").first().textContent()) ?? "",
  );
  const paragraphs = (
    await page.locator("div.muye-reader-content p").allTextContents()
  )
    .map(clean)
    .filter(Boolean);
  const pageText = await page.locator("body").innerText();
  return {
    title: title || null,
    paragraphs,
    expectedParagraphs: null,
    preview: containsPreviewMarker(pageText),
  };
}

function circuitOpen(name: string): boolean {
  const state = mirrorCircuits.get(name);
  if (!state) return false;
  if (state.retryAt <= Date.now()) {
    mirrorCircuits.delete(name);
    return false;
  }
  return state.failures >= CIRCUIT_FAILURES;
}

function mirrorSucceeded(name: string): void {
  mirrorCircuits.delete(name);
}

function mirrorFailed(name: string): void {
  const previous = mirrorCircuits.get(name);
  const failures = (previous?.failures ?? 0) + 1;
  mirrorCircuits.set(name, {
    failures,
    retryAt:
      failures >= CIRCUIT_FAILURES ? Date.now() + CIRCUIT_COOLDOWN_MS : 0,
  });
}

async function waitForMirror(mirror: ChapterMirrorBackend): Promise<void> {
  const cooldownMs = Math.max(0, mirror.cooldownMs ?? 0);
  if (cooldownMs === 0) return;
  const waitMs = Math.max(
    0,
    (mirrorNextRequestAt.get(mirror.name) ?? 0) - Date.now(),
  );
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  mirrorNextRequestAt.set(mirror.name, Date.now() + cooldownMs);
}

export async function getCompleteChapter(
  chapterId: string,
  options: ClientOptions,
): Promise<ChapterContent> {
  const errors: string[] = [];
  const url = `${BASE_URL}/reader/${chapterId}`;
  let fallbackTitle = chapterId;

  try {
    const ssr = parseSsrBody(await getHtml(url, options));
    fallbackTitle = ssr.title || fallbackTitle;
    validateBody(ssr, "official-ssr");
    report(options, { source: "official-ssr", status: "success" });
    return toChapterContent(chapterId, fallbackTitle, "official-ssr", ssr);
  } catch (error) {
    const message = errorMessage(error);
    errors.push(`official-ssr: ${message}`);
    report(options, {
      source: "official-ssr",
      status: "failed",
      error: message,
    });
  }

  if (options.fanqieCookie || options.tryAnonymousFullApi) {
    const source = "official-full-api";
    try {
      const body = await getText(
        `${BASE_URL}/api/reader/full?itemId=${chapterId}`,
        {
          ...options,
          retries: 0,
          timeoutMs: Math.min(options.timeoutMs ?? 8_000, 8_000),
        },
        {
          accept: "application/json,text/plain,*/*",
          allowEmpty: true,
          headers: options.fanqieCookie
            ? { Cookie: options.fanqieCookie, Referer: url }
            : { Referer: url },
        },
      );
      if (!body) throw new TomatoError("官方全文 API 返回空响应");
      const parsed = validateBody(parseJsonBody(body), source);
      report(options, { source, status: "success" });
      return toChapterContent(chapterId, fallbackTitle, source, parsed);
    } catch (error) {
      const message = errorMessage(error);
      errors.push(`${source}: ${message}`);
      report(options, { source, status: "failed", error: message });
    }
  }

  if (options.browserChapterFallback || options.fanqieCookie) {
    const source = "official-browser";
    try {
      const parsed = await getDefaultBrowserPool().withPage((page) =>
        browserBody(page, chapterId, options),
      );
      validateBody(parsed, source);
      report(options, { source, status: "success" });
      return toChapterContent(chapterId, fallbackTitle, source, parsed);
    } catch (error) {
      const message = errorMessage(error);
      errors.push(`${source}: ${message}`);
      report(options, { source, status: "failed", error: message });
    }
  }

  const mirrors = options.chapterMirrors ?? DEFAULT_CHAPTER_MIRRORS;
  for (const mirror of mirrors) {
    if (circuitOpen(mirror.name)) {
      report(options, {
        source: mirror.name,
        status: "skipped",
        error: "circuit open",
      });
      continue;
    }
    try {
      await waitForMirror(mirror);
      const mirrorUrl = mirror.url.replaceAll("{chapterId}", chapterId);
      const body = await getText(
        mirrorUrl,
        {
          ...options,
          retries: 0,
          timeoutMs: mirror.timeoutMs ?? 6_000,
        },
        {
          accept: "application/json,text/plain,*/*",
          headers: mirror.headers ? { ...mirror.headers } : undefined,
        },
      );
      const parsed = validateBody(parseJsonBody(body), mirror.name);
      mirrorSucceeded(mirror.name);
      report(options, { source: mirror.name, status: "success" });
      return toChapterContent(chapterId, fallbackTitle, mirror.name, parsed);
    } catch (error) {
      mirrorFailed(mirror.name);
      const message = errorMessage(error);
      errors.push(`${mirror.name}: ${message}`);
      report(options, {
        source: mirror.name,
        status: "failed",
        error: message,
      });
    }
  }

  throw new TomatoError(
    `章节 ${chapterId} 的所有全文后端均失败：${errors.join("；")}`,
  );
}
