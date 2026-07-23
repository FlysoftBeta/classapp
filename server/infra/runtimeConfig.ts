import fs from "fs";
import path from "path";

export interface ClassAppRuntimeConfig {
  appDir: string;
  dataRoot: string;
  buildId: string;
  ports: number[];
  securePorts: number[];
  bindHost: string;
  nodeEnv: string;
  initialAdminPin?: string;
  https: {
    domain: string | null;
    certificatePath: string | null;
    privateKeyPath: string | null;
    rootCertificatePath: string | null;
  };
  update: {
    enabled: boolean;
    stagingDir: string;
    backupDir: string;
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
  const buildIdPath = path.join(appDir, "build-id.txt");
  const buildId =
    nodeEnv === "production" && fs.existsSync(buildIdPath)
      ? fs.readFileSync(buildIdPath, "utf8").trim() || "dev"
      : "dev";

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
    nodeEnv,
    initialAdminPin: nodeEnv === "production" ? undefined : "123456",
    https: {
      domain: null,
      certificatePath: null,
      privateKeyPath: null,
      rootCertificatePath: null,
    },
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
