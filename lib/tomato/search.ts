import { errors as playwrightErrors, type Response } from "playwright";
import { BrowserPool, getDefaultBrowserPool } from "./browser";
import { decodeSearchText } from "./decode";
import { TomatoError, VerificationRequiredError } from "./errors";
import { BASE_URL } from "./http";
import type { SearchBook, SearchOptions } from "./types";

const SEARCH_API_FRAGMENT = "/api/author/search/search_book/v1";
const SEARCH_DECODE_KEYS = [
  "book_name",
  "author",
  "book_abstract",
  "category",
  "last_chapter_title",
] as const;
const SEARCH_ID_KEYS = [
  "book_id",
  "first_chapter_id",
  "last_chapter_id",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function randomInteger(minimum: number, maximum: number): number {
  return Math.floor(Math.random() * (maximum - minimum + 1)) + minimum;
}

function normalizeSearchBook(raw: Record<string, unknown>): SearchBook | null {
  const item = { ...raw };
  for (const key of SEARCH_DECODE_KEYS) {
    if (typeof item[key] === "string") item[key] = decodeSearchText(item[key]);
  }
  for (const key of SEARCH_ID_KEYS) {
    if (item[key] !== undefined && item[key] !== null)
      item[key] = String(item[key]);
  }
  return typeof item.book_id === "string" && item.book_id.length > 0
    ? (item as SearchBook)
    : null;
}

function booksFromPayload(payload: unknown): Record<string, unknown>[] {
  if (!isRecord(payload) || !isRecord(payload.data)) return [];
  const books = payload.data.search_book_data_list;
  return Array.isArray(books) ? books.filter(isRecord) : [];
}

/** Browser implementation. Prefer TomatoClient.searchBooks for throttling. */
export async function searchBooksWithBrowser(
  query: string,
  options: SearchOptions = {},
  browserPool: BrowserPool = getDefaultBrowserPool(),
): Promise<SearchBook[]> {
  if (query.trim().length === 0) return [];
  const pages = Math.max(1, Math.floor(options.pages ?? 1));
  const humanize = options.humanize ?? true;
  const timeoutMs = options.timeoutMs ?? 45_000;
  const payloads: unknown[] = [];
  const parseErrors: string[] = [];
  let verificationDetected = false;

  await browserPool.withPage(async (page) => {
    page.on("response", (response: Response) => {
      if (!response.url().includes(SEARCH_API_FRAGMENT)) return;
      const headers = response.headers();
      if (headers["bdturing-verify"] || headers["x-vc-bdturing-parameters"]) {
        verificationDetected = true;
      }
      void response.json().then(
        (payload: unknown) => payloads.push(payload),
        (error: unknown) =>
          parseErrors.push(
            error instanceof Error ? error.message : String(error),
          ),
      );
    });

    try {
      if (humanize) {
        await page.goto(`${BASE_URL}/`, {
          waitUntil: "domcontentloaded",
          timeout: timeoutMs,
        });
        const searchInput = page.getByPlaceholder("请输入书名或作者名", {
          exact: true,
        });
        await searchInput.waitFor({ state: "visible", timeout: timeoutMs });
        await page.waitForTimeout(randomInteger(700, 1_600));
        const box = await searchInput.boundingBox();
        if (box) {
          await page.mouse.move(120, 180);
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
            steps: randomInteger(8, 16),
          });
        }
        await searchInput.click();
        await searchInput.pressSequentially(query, {
          delay: randomInteger(70, 140),
        });
        await page.waitForTimeout(randomInteger(500, 1_300));
        await searchInput.press("Enter");
        await page.waitForFunction(
          () => location.pathname.startsWith("/search/"),
          undefined,
          { timeout: timeoutMs },
        );
      } else {
        await page.goto(`${BASE_URL}/search/${encodeURIComponent(query)}`, {
          waitUntil: "domcontentloaded",
          timeout: timeoutMs,
        });
      }

      let deadline = Date.now() + timeoutMs;
      while ((await page.locator(".search-book-item").count()) === 0) {
        if (verificationDetected && !browserPool.headed) {
          throw new VerificationRequiredError(
            "无头搜索触发了浏览器验证，请在服务端配置 headed 浏览器人工处理",
          );
        }
        if (Date.now() >= deadline) {
          throw new playwrightErrors.TimeoutError("search result timeout");
        }
        await page.waitForTimeout(100);
      }
      deadline = Date.now() + 3_000;
      while (payloads.length === 0 && Date.now() < deadline) {
        await page.waitForTimeout(50);
      }

      for (let pageIndex = 1; pageIndex < pages; pageIndex += 1) {
        const nextButton = page.locator(
          ".muye-search-pagination li:has(svg.byte-icon-right)",
        );
        if (
          (await nextButton.count()) !== 1 ||
          (await nextButton.getAttribute("class"))?.includes("disabled")
        )
          break;
        const before = payloads.length;
        await nextButton.click();
        deadline = Date.now() + timeoutMs;
        while (payloads.length === before && Date.now() < deadline) {
          await page.waitForTimeout(50);
        }
        if (payloads.length === before) {
          throw new TomatoError("翻页后没有捕获到搜索接口响应");
        }
      }
    } catch (error) {
      if (error instanceof playwrightErrors.TimeoutError) {
        throw new VerificationRequiredError(
          "搜索结果加载超时，可能触发了浏览器验证",
          { cause: error },
        );
      }
      throw error;
    }
  });

  if (payloads.length === 0) {
    const detail = parseErrors.at(-1);
    throw new VerificationRequiredError(
      `搜索接口没有返回可解析 JSON${detail ? `：${detail}` : ""}`,
    );
  }

  const books: SearchBook[] = [];
  const seen = new Set<string>();
  for (const payload of payloads) {
    for (const raw of booksFromPayload(payload)) {
      const book = normalizeSearchBook(raw);
      if (book && !seen.has(book.book_id)) {
        seen.add(book.book_id);
        books.push(book);
      }
    }
  }
  return books;
}
