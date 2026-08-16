import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface PlatformRuntimeConfig {
  pdfRender: {
    rendererPath: string;
    environment: Record<string, string>;
  };
  media: MediaRuntimeConfig;
}

export interface MediaRuntimeConfig {
  ytDlpPath: string | null;
  potServerEntry: string | null;
  /** yt-dlp plugin roots; each may contain several plugin packages. */
  pluginDirs: string[];
}

export interface HTTPSRuntimeConfig {
  domain: string;
  certificatePath: string;
  privateKeyPath: string;
  rootCertificatePath: string;
  /** Overrides the persisted HTTPS redirect setting when non-null. */
  redirectOverride: boolean | null;
}

export interface UpdateRuntimeConfig {
  stagingDir: string;
  backupDir: string;
}

export interface RuntimeConfig {
  appDir: string;
  dataRoot: string;
  buildId: string;
  ports: number[];
  securePorts: number[];
  bindHost: string;
  /** Peer addresses allowed to supply forwarding headers. */
  trustedProxyIps: string[];
  nodeEnv: string;
  debugOverride?: boolean;
  initialAdminPin?: string;
  platform: PlatformRuntimeConfig;
  media?: MediaRuntimeConfig;
  https?: HTTPSRuntimeConfig;
  update?: UpdateRuntimeConfig;
}

function linuxDevelopmentRendererDirectory(appDir: string): string {
  let distribution = "linux-redhat";
  try {
    const release = readFileSync("/etc/os-release", "utf8");
    const identity = release
      .split("\n")
      .filter((line) => /^(ID|ID_LIKE)=/.test(line))
      .join(" ")
      .toLowerCase();
    if (/debian|ubuntu/.test(identity)) distribution = "linux-debian";
  } catch {
    // Red Hat-compatible is the development fallback used by release builds.
  }
  return path.join(appDir, "lib", "poppler-prebuilt", distribution);
}

interface MediaManifest {
  ytDlp?: {
    version?: unknown;
  };
  potProvider?: {
    sourceRef?: unknown;
  };
}

/**
 * Development uses the same verified `.cache/media` tree as release builds.
 * `npm run media:update` prepares the POT server; the first build/dev run may
 * download yt-dlp and the plugin through the update/build scripts.
 */
function developmentMediaPaths(appDir: string): MediaRuntimeConfig {
  const resolved: MediaRuntimeConfig = {
    ytDlpPath: null,
    potServerEntry: null,
    pluginDirs: [],
  };
  try {
    const manifest = JSON.parse(
      readFileSync(
        path.join(appDir, "lib", "media", "artifacts-manifest.json"),
        "utf8",
      ),
    ) as MediaManifest;
    const ytDlpVersion =
      typeof manifest.ytDlp?.version === "string"
        ? manifest.ytDlp.version
        : null;
    const potTag =
      typeof manifest.potProvider?.sourceRef === "string"
        ? manifest.potProvider.sourceRef.replace(/^tag\s+/, "")
        : null;
    const configuredCache = process.env.CLASSAPP_BUILD_CACHE;
    const mediaCache = path.join(
      configuredCache ? path.resolve(appDir, configuredCache) : appDir,
      ".cache",
      "media",
    );
    const platform = process.platform === "win32" ? "windows" : "linux";
    const ytDlpPath =
      platform === "windows"
        ? ytDlpVersion
          ? path.join(
              mediaCache,
              "yt-dlp",
              `windows-extract-${ytDlpVersion}`,
              "yt-dlp.exe",
            )
          : null
        : ytDlpVersion
          ? path.join(mediaCache, "yt-dlp", ytDlpVersion, "yt-dlp_linux")
          : null;
    const potServerEntry = potTag
      ? path.join(mediaCache, "pot-server", potTag, platform, "main.js")
      : null;
    const pluginDirs = [
      path.join(mediaCache, "pot-plugin"),
      path.join(appDir, "lib", "media", "ytdlp-plugins"),
    ];
    resolved.ytDlpPath =
      ytDlpPath && existsSync(ytDlpPath) ? ytDlpPath : null;
    resolved.potServerEntry =
      potServerEntry && existsSync(potServerEntry) ? potServerEntry : null;
    resolved.pluginDirs = pluginDirs.filter((pluginDir) =>
      existsSync(pluginDir),
    );
  } catch {
    // Keep any explicit environment overrides even without a manifest.
  }
  const pluginDirs = process.env.CLASSAPP_MEDIA_PLUGIN_DIR
    ? process.env.CLASSAPP_MEDIA_PLUGIN_DIR.split(path.delimiter)
    : resolved.pluginDirs;
  return {
    ytDlpPath: process.env.CLASSAPP_MEDIA_YTDLP_PATH ?? resolved.ytDlpPath,
    potServerEntry:
      process.env.CLASSAPP_MEDIA_POT_ENTRY ?? resolved.potServerEntry,
    pluginDirs: pluginDirs.filter(
      (pluginDir) => pluginDir !== "" && existsSync(pluginDir),
    ),
  };
}

export function createPlatformRuntimeConfig(
  appDir: string,
  nodeEnv: string,
): PlatformRuntimeConfig {
  const windows = process.platform === "win32";
  const platformDirectory = windows ? "windows" : "linux";
  const executable = windows ? "pdfrender.exe" : "pdfrender";
  const packagedDirectory = path.join(
    appDir,
    "server",
    "pdfrender",
    platformDirectory,
  );
  const rendererDirectory =
    nodeEnv === "production"
      ? packagedDirectory
      : windows
        ? path.join(appDir, "lib", "poppler-prebuilt", "windows")
        : linuxDevelopmentRendererDirectory(appDir);
  const rendererPath =
    process.env.CLASSAPP_PDFRENDER_PATH ??
    path.join(rendererDirectory, executable);
  const packagedMedia = path.join(appDir, "server", "media");
  const media: MediaRuntimeConfig =
    nodeEnv === "production"
      ? {
          ytDlpPath: path.join(
            packagedMedia,
            windows ? "yt-dlp.exe" : "yt-dlp_linux",
          ),
          potServerEntry: path.join(packagedMedia, "pot-server", "main.js"),
          pluginDirs: [path.join(packagedMedia, "pot-plugin")],
        }
      : developmentMediaPaths(appDir);
  return {
    pdfRender: {
      rendererPath,
      environment: windows
        ? {}
        : {
            LD_LIBRARY_PATH: [
              path.dirname(rendererPath),
              process.env.LD_LIBRARY_PATH,
            ]
              .filter(Boolean)
              .join(path.delimiter),
          },
    },
    media,
  };
}

export interface RuntimeController {
  requestUpdate(dbBackup: string): void;
  requestRollback(dbBackup?: string): void;
  confirmUpdate(): void;
  restart(delayMs?: number, exitCode?: number): void;
}

declare global {
  var __classappRuntimeConfig: RuntimeConfig | undefined;
  var __classappRuntimeController: RuntimeController | undefined;
}

export function runtimeConfig(): RuntimeConfig {
  if (!globalThis.__classappRuntimeConfig) throw new Error("应用未初始化");
  return globalThis.__classappRuntimeConfig;
}

export function setRuntimeConfig(config: RuntimeConfig): RuntimeConfig {
  globalThis.__classappRuntimeConfig = config;
  return config;
}

export function runtimeController(): RuntimeController | null {
  return globalThis.__classappRuntimeController ?? null;
}

export function setRuntimeController(
  controller: RuntimeController,
): RuntimeController {
  globalThis.__classappRuntimeController = controller;
  return controller;
}
