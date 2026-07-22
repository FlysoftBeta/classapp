import { TomatoError, VerificationRequiredError } from "./errors";
import type { HttpOptions } from "./types";

export const BASE_URL = "https://fanqienovel.com";
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/149.0.0.0 Safari/537.36";

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function getText(
  url: string,
  options: HttpOptions = {},
  request: {
    accept?: string;
    headers?: Record<string, string>;
    allowEmpty?: boolean;
  } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const retries = Math.max(0, options.retries ?? 4);
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const forwardAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", forwardAbort, { once: true });
    try {
      const response = await fetch(url, {
        headers: {
          Accept: request.accept ?? "*/*",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
          "User-Agent": options.userAgent ?? DEFAULT_USER_AGENT,
          ...request.headers,
        },
        redirect: "follow",
        signal: controller.signal,
      });
      const retryable =
        response.status === 429 ||
        (response.status >= 500 && response.status <= 504);
      if (retryable && attempt < retries) {
        await response.arrayBuffer();
        await sleep(800 * 2 ** attempt);
        continue;
      }
      if (!response.ok) {
        throw new TomatoError(`${url} 返回 HTTP ${response.status}`);
      }
      const body = await response.text();
      if (
        body.length === 0 &&
        (response.headers.has("bdturing-verify") ||
          response.headers.has("x-vc-bdturing-parameters"))
      ) {
        throw new VerificationRequiredError(
          "番茄要求浏览器验证，裸 HTTP 响应为空",
        );
      }
      if (body.length === 0 && !request.allowEmpty) {
        throw new TomatoError(`${url} 返回了空响应`);
      }
      return body;
    } catch (error) {
      lastError = error;
      if (
        error instanceof TomatoError ||
        options.signal?.aborted ||
        attempt >= retries
      ) {
        throw error;
      }
      await sleep(800 * 2 ** attempt);
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", forwardAbort);
    }
  }

  throw new TomatoError(`请求 ${url} 失败：${errorMessage(lastError)}`);
}

export async function getHtml(
  url: string,
  options: HttpOptions = {},
): Promise<string> {
  return getText(url, options, {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  });
}
