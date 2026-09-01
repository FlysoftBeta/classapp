import { spawn, type ChildProcess } from "node:child_process";
import { MediaError } from "./errors";
import { coverUrlOf, createProviderTrack } from "./track";
import type {
  MediaProvider,
  ProviderStream,
  ProviderTrack,
  StreamOptions,
} from "./types";

export interface YtDlpProviderOptions {
  binaryPath: string | null;
  nodePath?: string;
  pluginDirs?: readonly string[];
  potBaseUrl?: string | null;
  searchTimeoutMs?: number;
  infoTimeoutMs?: number;
  maxSearchOutputBytes?: number;
  maxInfoOutputBytes?: number;
}

const SOURCE = "youtube-music";
const AUDIO_FORMAT = "bestaudio[acodec=opus]/bestaudio";
const MUSIC_SEARCH_URL =
  "https://music.youtube.com/search?sp=EgWKAQIIAWoKEAoQAxAEEAkQBQ%3D%3D";

interface YtDlpRunResult {
  stdout: Buffer;
  stderr: string;
}

interface RawEntry {
  id?: unknown;
  title?: unknown;
  duration?: unknown;
  album?: unknown;
  artists?: unknown;
  artist?: unknown;
  channel?: unknown;
  thumbnail?: unknown;
  thumbnails?: unknown;
  webpage_url?: unknown;
  original_url?: unknown;
  url?: unknown;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNonnegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function bestThumbnailUrl(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  let best: { url: string; preference: number } | null = null;
  for (const item of value) {
    if (item === null || typeof item !== "object") continue;
    const url = asString((item as { url?: unknown }).url);
    if (!url) continue;
    const rawPreference = (item as { preference?: unknown }).preference;
    const preference =
      typeof rawPreference === "number" && Number.isFinite(rawPreference)
        ? rawPreference
        : 0;
    if (!best || preference > best.preference) best = { url, preference };
  }
  return best?.url ?? null;
}

function coverUrlFrom(raw: RawEntry): string | null {
  return asString(raw.thumbnail) ?? bestThumbnailUrl(raw.thumbnails);
}

function normalizeEntry(raw: RawEntry): ProviderTrack | null {
  const providerId = asString(raw.id);
  const title = asString(raw.title);
  if (!providerId || !title) return null;
  const duration = asNonnegativeNumber(raw.duration);
  if (duration === null) return null;
  const artists = asStringArray(raw.artists);
  const artist = asString(raw.artist);
  const channel = asString(raw.channel);
  const canonicalUrl =
    asString(raw.webpage_url) ??
    asString(raw.original_url) ??
    asString(raw.url) ??
    `https://music.youtube.com/watch?v=${encodeURIComponent(providerId)}`;
  return createProviderTrack(
    {
      source: SOURCE,
      providerId,
      canonicalUrl,
      title,
      artists: artists.length
        ? artists
        : artist || channel
          ? [artist ?? channel!]
          : [],
      album: asString(raw.album),
      durationMs: Math.round(duration * 1000),
    },
    coverUrlFrom(raw),
  );
}

/**
 * yt-dlp backend. The provider only parses upstream answers and resolves
 * tracks/covers into byte streams; throttling, storage, and server-owned
 * lifecycle stay with the caller.
 */
export class YtDlpProvider implements MediaProvider {
  readonly source = SOURCE;

  constructor(private readonly options: YtDlpProviderOptions) {}

  private binary(): string {
    if (!this.options.binaryPath) {
      throw new MediaError("backend-missing", "yt-dlp 后端未配置");
    }
    return this.options.binaryPath;
  }

  private baseArgs(): string[] {
    const args: string[] = ["--no-warnings"];
    // Keep one --extractor-args option per extractor key. Joining them with
    // ";" parses the youtube key but silently drops plugin keys such as
    // youtubepot-bgutilhttp, so yt-dlp would ignore the configured POT
    // server and fall back to its default local port.
    // Temporarily use android_vr so stream extraction does not need a PO
    // Token provider. Restore web_music + youtubepot-bgutilhttp together.
    args.push("--extractor-args", "youtube:player_client=android_vr");
    // args.push("--extractor-args", "youtube:player_client=web_music");
    // if (this.options.potBaseUrl) {
    //   args.push(
    //     "--extractor-args",
    //     `youtubepot-bgutilhttp:base_url=${this.options.potBaseUrl}`,
    //   );
    // }
    if (this.options.nodePath) {
      args.push("--js-runtimes", `node:${this.options.nodePath}`);
    }
    for (const pluginDir of this.options.pluginDirs ?? []) {
      if (pluginDir) args.push("--plugin-dirs", pluginDir);
    }
    return args;
  }

  /** Bounded parse invocation: stdout must stay small enough for JSON.parse. */
  private runBounded(
    args: string[],
    timeoutMs: number,
    maxOutputBytes: number,
    signal: AbortSignal,
  ): Promise<YtDlpRunResult> {
    if (signal.aborted) {
      return Promise.reject(new MediaError("cancelled", "媒体后端请求已取消"));
    }
    return new Promise<YtDlpRunResult>((resolve, reject) => {
      const child = spawn(this.binary(), args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: string[] = [];
      let stdoutBytes = 0;
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined = undefined;

      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
      };
      const fail = (error: MediaError) => {
        if (settled) return;
        settled = true;
        cleanup();
        killChild(child);
        reject(error);
      };
      const onAbort = () =>
        fail(new MediaError("cancelled", "媒体后端请求已取消"));

      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      timeout = setTimeout(
        () => fail(new MediaError("timeout", "媒体后端请求超时", true)),
        timeoutMs,
      );
      timeout.unref();

      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxOutputBytes) {
          fail(new MediaError("output-too-large", "媒体后端输出超出限制"));
          return;
        }
        stdout.push(chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr.push(chunk.toString("utf8"));
        if (stderr.length > 500) stderr.shift();
      });
      child.once("error", (error) => {
        fail(
          new MediaError(
            "provider-unavailable",
            `无法启动 yt-dlp: ${error.message}`,
            true,
          ),
        );
      });
      child.once("exit", (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (code !== 0) {
          reject(classifyExit(code, stderr.join("")));
          return;
        }
        resolve({
          stdout: Buffer.concat(stdout),
          stderr: stderr.join(""),
        });
      });
    });
  }

  async search(
    query: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<ProviderTrack[]> {
    const url = `${MUSIC_SEARCH_URL}&q=${encodeURIComponent(query)}`;
    const result = await this.runBounded(
      [
        ...this.baseArgs(),
        // The classapp-music-search plugin puts artist/album/duration and
        // thumbnail into the flat entries, so search never downloads one
        // video at a time to recover that metadata.
        "--flat-playlist",
        "--dump-single-json",
        "--playlist-items",
        `1-${limit}`,
        url,
      ],
      this.options.searchTimeoutMs ?? 50_000,
      this.options.maxSearchOutputBytes ?? 64 * 1024 * 1024,
      signal,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout.toString("utf8"));
    } catch {
      throw new MediaError("invalid-payload", "媒体搜索返回了无效数据");
    }
    if (parsed === null || typeof parsed !== "object") {
      throw new MediaError("invalid-payload", "媒体搜索返回了无效数据");
    }
    const rawEntries = (parsed as { entries?: unknown }).entries;
    if (!Array.isArray(rawEntries)) {
      throw new MediaError("invalid-payload", "媒体搜索没有返回结果列表");
    }
    return rawEntries
      .map((entry) => normalizeEntry(entry as RawEntry))
      .filter((track): track is ProviderTrack => track !== null);
  }

  async streamTrack(
    track: ProviderTrack,
    options: StreamOptions,
  ): Promise<ProviderStream> {
    if (options.signal.aborted) {
      throw new MediaError("cancelled", "媒体流请求已取消");
    }
    const child = spawn(
      this.binary(),
      [
        ...this.baseArgs(),
        "--format",
        AUDIO_FORMAT,
        "--no-playlist",
        "--newline",
        "--progress",
        "--output",
        "-",
        track.canonicalUrl,
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    return streamFromChild(child, "audio/webm", options);
  }

  async streamCover(
    track: ProviderTrack,
    options: StreamOptions,
  ): Promise<ProviderStream> {
    // Tracks derived from search results or server rows usually carry a
    // hidden cover locator. Otherwise parse one bounded info dump first; the
    // caller never has to handle thumbnail URLs itself.
    const coverUrl =
      coverUrlOf(track) ?? (await this.resolveCoverUrl(track, options.signal));
    if (!coverUrl) throw new MediaError("not-found", "该曲目没有封面");
    if (options.signal.aborted) {
      throw new MediaError("cancelled", "封面流请求已取消");
    }

    const controller = new AbortController();
    let stopped = false;
    const onAbort = () => {
      stopped = true;
      controller.abort();
    };
    options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.signal.aborted) {
      onAbort();
      throw new MediaError("cancelled", "封面流请求已取消");
    }

    let response: Response;
    try {
      response = await fetch(coverUrl, { signal: controller.signal });
    } catch (error) {
      options.signal.removeEventListener("abort", onAbort);
      if (options.signal.aborted) {
        throw new MediaError("cancelled", "封面流请求已取消");
      }
      throw new MediaError(
        "provider-unavailable",
        `封面下载失败：${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
    if (!response.ok) {
      options.signal.removeEventListener("abort", onAbort);
      throw new MediaError(
        "provider-unavailable",
        `封面下载失败：HTTP ${response.status}`,
        true,
      );
    }
    const body = response.body;
    if (!body) {
      options.signal.removeEventListener("abort", onAbort);
      throw new MediaError("invalid-payload", "封面响应没有内容");
    }
    const contentType =
      response.headers.get("content-type")?.split(";")[0]?.trim() ||
      "image/jpeg";
    return {
      contentType,
      async *read() {
        const reader = body.getReader();
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) return;
            if (value) yield value;
          }
        } catch {
          if (stopped || options.signal.aborted) {
            throw new MediaError("cancelled", "封面流已取消");
          }
          throw new MediaError("provider-unavailable", "封面流传输中断", true);
        } finally {
          try {
            reader.releaseLock();
          } catch {
            // Already closed or still settling; nothing to release.
          }
        }
      },
      async stop() {
        options.signal.removeEventListener("abort", onAbort);
        stopped = true;
        controller.abort();
        try {
          await body.cancel();
        } catch {
          // Locked by an active reader; the abort above makes it fail instead.
        }
      },
    };
  }

  /** Parse yt-dlp's own info JSON when a track carries no cover locator. */
  private async resolveCoverUrl(
    track: ProviderTrack,
    signal: AbortSignal,
  ): Promise<string | null> {
    const result = await this.runBounded(
      [
        ...this.baseArgs(),
        "--skip-download",
        "--dump-single-json",
        "--no-playlist",
        track.canonicalUrl,
      ],
      this.options.infoTimeoutMs ?? 120_000,
      this.options.maxInfoOutputBytes ?? 16 * 1024 * 1024,
      signal,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout.toString("utf8"));
    } catch {
      throw new MediaError("invalid-payload", "媒体信息返回了无效数据");
    }
    if (parsed === null || typeof parsed !== "object") {
      throw new MediaError("invalid-payload", "媒体信息返回了无效数据");
    }
    return coverUrlFrom(parsed as RawEntry);
  }
}

function streamFromChild(
  child: ChildProcess,
  contentType: string,
  options: StreamOptions,
): ProviderStream {
  let stopped = false;
  let stderrTail = "";

  const onAbort = () => {
    stopped = true;
    killChild(child);
  };
  options.signal.addEventListener("abort", onAbort, { once: true });
  if (options.signal.aborted) {
    onAbort();
  }

  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-4096);
    if (options.onProgress) {
      for (const line of chunk.toString("utf8").split("\n")) {
        const match = /\[download\]\s+(\d+(?:\.\d+)?)%/.exec(line);
        if (match) options.onProgress(Number(match[1]));
      }
    }
  });

  const completion = new Promise<void>((resolve, reject) => {
    child.once("error", (error) => {
      reject(
        new MediaError(
          "provider-unavailable",
          `无法启动 yt-dlp: ${error.message}`,
          true,
        ),
      );
    });
    child.once("exit", (code) => {
      if (stopped || options.signal.aborted) {
        reject(new MediaError("cancelled", "媒体流已取消"));
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      reject(classifyExit(code, stderrTail));
    });
  });
  void completion.catch(() => undefined);

  async function* read(): AsyncIterable<Uint8Array> {
    const stdout = child.stdout;
    if (!stdout) {
      await completion;
      return;
    }
    try {
      for await (const chunk of stdout) {
        yield chunk;
      }
    } catch (error) {
      // A kill can close stdout before the exit handler wins the race;
      // completion carries the classified reason, so prefer it here.
      try {
        await completion;
      } catch (failure) {
        throw failure;
      }
      throw error;
    }
    await completion;
  }

  return {
    contentType,
    read,
    stop: async () => {
      options.signal.removeEventListener("abort", onAbort);
      stopped = true;
      killChild(child);
      await completion.catch(() => undefined);
    },
  };
}

function classifyExit(code: number | null, stderr: string): MediaError {
  if (/429|too many requests|rate.?limit/i.test(stderr)) {
    return new MediaError("rate-limited", "媒体后端触发限流，请稍后重试", true);
  }
  if (/po.?token|pot:/i.test(stderr)) {
    return new MediaError("pot-unavailable", "PO Token 服务不可用", true);
  }
  if (/requested format is not available/i.test(stderr)) {
    return new MediaError(
      "provider-unavailable",
      "当前媒体客户端配置无法获取音频格式（可能需要 PO Token 服务）",
      true,
    );
  }
  if (
    /not available|unable to download video|video unavailable/i.test(stderr)
  ) {
    return new MediaError("not-found", "该曲目当前不可用");
  }
  return new MediaError(
    "provider-unavailable",
    `yt-dlp 退出码 ${code ?? "unknown"}`,
    true,
  );
}

function killChild(child: ChildProcess): void {
  if (child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  } else {
    child.kill("SIGKILL");
  }
}
