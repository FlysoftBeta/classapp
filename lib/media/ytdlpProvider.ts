import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { MediaError } from "./errors";
import type {
  LiveStreamHandle,
  MaterializedAsset,
  MediaProgressFn,
  MediaProvider,
  ProviderTrack,
} from "./types";
import { LayerThrottle } from "./throttle";

export interface YtDlpProviderOptions {
  binaryPath: string | null;
  nodePath?: string;
  pluginDirs?: readonly string[];
  potBaseUrl?: string | null;
  searchCooldownMs?: number;
  downloadCooldownMs?: number;
  searchTimeoutMs?: number;
  downloadTimeoutMs?: number;
  maxSearchOutputBytes?: number;
}

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
  return {
    source: "youtube-music",
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
    thumbnailUrl: asString(raw.thumbnail),
  };
}

export class YtDlpProvider implements MediaProvider {
  readonly source = "youtube-music";
  private readonly searchThrottle: LayerThrottle;
  private readonly downloadThrottle: LayerThrottle;
  private cooldownUntil = 0;

  constructor(private readonly options: YtDlpProviderOptions) {
    this.searchThrottle = new LayerThrottle(options.searchCooldownMs ?? 5_000);
    this.downloadThrottle = new LayerThrottle(
      options.downloadCooldownMs ?? 1_000,
    );
  }

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
    args.push("--extractor-args", "youtube:player_client=web_music");
    if (this.options.potBaseUrl) {
      args.push(
        "--extractor-args",
        `youtubepot-bgutilhttp:base_url=${this.options.potBaseUrl}`,
      );
    }
    if (this.options.nodePath) {
      args.push("--js-runtimes", `node:${this.options.nodePath}`);
    }
    for (const pluginDir of this.options.pluginDirs ?? []) {
      if (pluginDir) args.push("--plugin-dirs", pluginDir);
    }
    return args;
  }

  private async run(
    args: string[],
    timeoutMs: number,
    maxOutputBytes: number,
    signal: AbortSignal,
    cooldownLayer: "search" | "download",
    onProgress?: MediaProgressFn,
  ): Promise<YtDlpRunResult> {
    const binary = this.binary();
    const throttle =
      cooldownLayer === "search" ? this.searchThrottle : this.downloadThrottle;
    return throttle.run(async () => {
      if (Date.now() < this.cooldownUntil) {
        throw new MediaError(
          "rate-limited",
          "媒体后端正在冷却，请稍后重试",
          true,
        );
      }
      return new Promise<YtDlpRunResult>((resolve, reject) => {
        const child = spawn(binary, args, {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const stdout: Buffer[] = [];
        const stderr: string[] = [];
        let stdoutBytes = 0;
        let settled = false;

        const onAbort = () => {
          killChild(child);
          if (!settled) {
            settled = true;
            reject(new MediaError("cancelled", "媒体后端请求已取消"));
          }
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });

        const timeout = setTimeout(() => {
          killChild(child);
          if (!settled) {
            settled = true;
            reject(new MediaError("timeout", "媒体后端请求超时", true));
          }
        }, timeoutMs);
        timeout.unref();

        child.stdout.on("data", (chunk: Buffer) => {
          stdoutBytes += chunk.length;
          if (stdoutBytes > maxOutputBytes) {
            killChild(child);
            if (!settled) {
              settled = true;
              reject(
                new MediaError("output-too-large", "媒体后端输出超出限制"),
              );
            }
            return;
          }
          stdout.push(chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          stderr.push(text);
          if (stderr.length > 500) stderr.shift();
          if (onProgress) {
            for (const line of text.split("\n")) {
              const match = /\[download\]\s+(\d+(?:\.\d+)?)%/.exec(line);
              if (match) onProgress(Number(match[1]));
            }
          }
        });
        child.once("error", (error) => {
          clearTimeout(timeout);
          if (!settled) {
            settled = true;
            reject(
              new MediaError(
                "provider-unavailable",
                `无法启动 yt-dlp: ${error.message}`,
                true,
              ),
            );
          }
        });
        child.once("exit", (code) => {
          clearTimeout(timeout);
          signal.removeEventListener("abort", onAbort);
          if (settled) return;
          settled = true;
          const text = stderr.join("");
          if (code !== 0) {
            reject(classifyExit(code, text));
            return;
          }
          resolve({
            stdout: Buffer.concat(stdout),
            stderr: text,
          });
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
    const result = await this.run(
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
      "search",
    );
    const parsed: unknown = JSON.parse(result.stdout.toString("utf8"));
    if (parsed === null || typeof parsed !== "object") {
      throw new MediaError("invalid-payload", "媒体搜索返回了无效数据");
    }
    const rawEntries = (parsed as { entries?: unknown }).entries;
    if (!Array.isArray(rawEntries)) {
      throw new MediaError("invalid-payload", "媒体搜索没有返回结果列表");
    }
    const tracks = rawEntries
      .map((entry) => normalizeEntry(entry as RawEntry))
      .filter((track): track is ProviderTrack => track !== null);
    if (tracks.length === 0) return [];
    return tracks;
  }

  async download(
    track: ProviderTrack,
    outputPath: string,
    onProgress: MediaProgressFn,
    signal: AbortSignal,
  ): Promise<MaterializedAsset> {
    await this.run(
      [
        ...this.baseArgs(),
        "--format",
        "bestaudio[acodec=opus]/bestaudio",
        "--no-playlist",
        "--newline",
        "--progress",
        "--output",
        outputPath,
        track.canonicalUrl,
      ],
      this.options.downloadTimeoutMs ?? 60 * 60_000,
      Number.MAX_SAFE_INTEGER,
      signal,
      "download",
      onProgress,
    );
    const info = await stat(outputPath);
    if (!info.isFile() || info.size === 0) {
      throw new MediaError("invalid-payload", "媒体下载没有产生文件", true);
    }
    return describeFile(outputPath, info.size, "audio/webm");
  }

  async downloadCover(
    track: ProviderTrack,
    outputPath: string,
    signal: AbortSignal,
  ): Promise<MaterializedAsset> {
    if (!track.thumbnailUrl) {
      throw new MediaError("not-found", "该曲目没有封面");
    }
    const response = await fetch(track.thumbnailUrl, { signal });
    if (!response.ok) {
      throw new MediaError(
        "provider-unavailable",
        `封面下载失败：HTTP ${response.status}`,
        true,
      );
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const { writeFile } = await import("node:fs/promises");
    await writeFile(outputPath, bytes);
    return describeFile(outputPath, bytes.length, "image/jpeg");
  }

  async openLiveStream(
    track: ProviderTrack,
    onProgress: MediaProgressFn,
    signal: AbortSignal,
  ): Promise<LiveStreamHandle> {
    const binary = this.binary();
    const child = spawn(
      binary,
      [
        ...this.baseArgs(),
        "--format",
        "bestaudio[acodec=opus]/bestaudio",
        "--no-playlist",
        "--newline",
        "--progress",
        "--output",
        "-",
        track.canonicalUrl,
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    return readLiveChild(child, onProgress, signal);
  }
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

function describeFile(
  path: string,
  bytes: number,
  mime: string,
): Promise<MaterializedAsset> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk: Buffer) => hash.update(chunk));
    stream.on("end", () =>
      resolve({ path, bytes, mime, sha256: hash.digest("hex") }),
    );
  });
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

function readLiveChild(
  child: ChildProcess,
  onProgress: MediaProgressFn,
  signal: AbortSignal,
): Promise<LiveStreamHandle> {
  const chunks: Array<{ buffer: Uint8Array; resolve: () => void }> = [];
  const waiters: Array<() => void> = [];
  let ended = false;
  let error: unknown = null;

  const push = (buffer: Uint8Array): void => {
    chunks.push({
      buffer,
      resolve: () => undefined,
    });
    const waiter = waiters.shift();
    if (waiter) waiter();
  };

  async function* read(): AsyncIterable<Uint8Array> {
    for (;;) {
      const entry = chunks.shift();
      if (entry) {
        yield entry.buffer;
        entry.resolve();
        continue;
      }
      if (ended || error !== null) return;
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  }

  child.stdout?.on("data", (chunk: Buffer) => push(chunk));
  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-4096);
    for (const line of chunk.toString("utf8").split("\n")) {
      const match = /\[download\]\s+(\d+(?:\.\d+)?)%/.exec(line);
      if (match) onProgress(Number(match[1]));
    }
  });
  child.once("error", (value) => {
    error = value;
    ended = true;
    waiters.splice(0).forEach((resolve) => resolve());
  });
  child.once("exit", (code) => {
    ended = true;
    if (code !== 0 && error === null) {
      error = classifyExit(code, stderrTail);
    }
    waiters.splice(0).forEach((resolve) => resolve());
  });
  const onAbort = () => {
    killChild(child);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return Promise.resolve({
    read,
    stop: async () => {
      signal.removeEventListener("abort", onAbort);
      killChild(child);
      ended = true;
      waiters.splice(0).forEach((resolve) => resolve());
    },
  });
}
