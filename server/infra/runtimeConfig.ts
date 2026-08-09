import { readFileSync } from "node:fs";
import path from "node:path";
import { readBuildId } from "./buildId";

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

export interface ClassAppRuntimeConfig {
  appDir: string;
  dataRoot: string;
  buildId: string;
  ports: number[];
  securePorts: number[];
  bindHost: string;
  /** Peer addresses allowed to supply forwarding headers. */
  trustedProxyIps: string[];
  nodeEnv: string;
  initialAdminPin?: string;
  platform: PlatformRuntimeConfig;
  https: HTTPSRuntimeConfig | null;
  update: {
    enabled: boolean;
    stagingDir: string;
    backupDir: string;
  };
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

export interface ClassAppRuntimeController {
  requestUpdate(dbBackup: string): void;
  requestRollback(dbBackup?: string): void;
  confirmUpdate(): void;
  restart(delayMs?: number, exitCode?: number): void;
}

declare global {
  var __classappRuntimeConfig: ClassAppRuntimeConfig | undefined;
  var __classappRuntimeController: ClassAppRuntimeController | undefined;
}

function fallbackRuntimeConfig(): ClassAppRuntimeConfig {
  const dataRoot = path.resolve(process.cwd());
  const appDir = dataRoot;
  const nodeEnv = process.env.NODE_ENV ?? "development";
  const buildId = nodeEnv === "production" ? readBuildId(appDir) : "dev";

  return {
    appDir,
    dataRoot,
    buildId,
    ports:
      nodeEnv === "production"
        ? [80, 81, 82, 83, 84, 85, 86, 88]
        : [3000, 3001, 3002, 3003, 3004, 3005, 3006, 3007],
    securePorts: [],
    bindHost: "0.0.0.0",
    trustedProxyIps: [],
    nodeEnv,
    initialAdminPin: nodeEnv === "production" ? undefined : "123456",
    platform: createPlatformRuntimeConfig(appDir, nodeEnv),
    https: null,
    update: {
      enabled: false,
      stagingDir: path.join(dataRoot, "staging"),
      backupDir: path.join(dataRoot, "backup"),
    },
  };
}

export function getRuntimeConfig(): ClassAppRuntimeConfig {
  if (!globalThis.__classappRuntimeConfig) {
    globalThis.__classappRuntimeConfig = fallbackRuntimeConfig();
  }
  return globalThis.__classappRuntimeConfig;
}

export function setRuntimeConfig(
  config: ClassAppRuntimeConfig,
): ClassAppRuntimeConfig {
  globalThis.__classappRuntimeConfig = config;
  return config;
}

export function getRuntimeController(): ClassAppRuntimeController | null {
  return globalThis.__classappRuntimeController ?? null;
}

export function setRuntimeController(
  controller: ClassAppRuntimeController,
): ClassAppRuntimeController {
  globalThis.__classappRuntimeController = controller;
  return controller;
}

export function getPublicRuntimeConfig(): Pick<
  ClassAppRuntimeConfig,
  "buildId" | "ports" | "securePorts"
> {
  const runtime = getRuntimeConfig();
  return {
    buildId: runtime.buildId,
    ports: runtime.ports,
    securePorts: runtime.securePorts,
  };
}
