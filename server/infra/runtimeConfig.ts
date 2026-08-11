import { readFileSync } from "node:fs";
import path from "node:path";

export interface PlatformRuntimeConfig {
  pdfRender: {
    rendererPath: string;
    environment: Record<string, string>;
  };
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
