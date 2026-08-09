// Production runtime bootstrap. The launcher injects the complete runtime
// contract over IPC; this file intentionally contains no application logic.
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createPlatformRuntimeConfig,
  type ClassAppRuntimeConfig,
} from "@/server/infra/runtimeConfig";
import { readBuildId } from "@/server/infra/buildId";

interface BootMessage {
  type: "classapp:boot";
  payload: ClassAppRuntimeConfig;
}

function standaloneConfig(): ClassAppRuntimeConfig {
  const dataRoot = path.resolve(process.cwd());
  const appDir = __dirname;
  const nodeEnv = process.env.NODE_ENV ?? "production";
  return {
    appDir,
    dataRoot,
    buildId: readBuildId(appDir),
    ports:
      process.env.NODE_ENV === "production"
        ? [80, 81, 82, 83, 84, 85, 86, 88]
        : [3000],
    securePorts: [],
    bindHost: "0.0.0.0",
    trustedProxyIps: [],
    nodeEnv,
    initialAdminPin:
      process.env.NODE_ENV === "production" ? undefined : "123456",
    platform: createPlatformRuntimeConfig(appDir, nodeEnv),
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

function isRuntimeConfig(value: unknown): value is ClassAppRuntimeConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as Partial<ClassAppRuntimeConfig>;
  return (
    typeof config.appDir === "string" &&
    typeof config.dataRoot === "string" &&
    typeof config.buildId === "string" &&
    Array.isArray(config.ports) &&
    config.ports.every(
      (port) => Number.isInteger(port) && port > 0 && port <= 65535,
    ) &&
    Array.isArray(config.securePorts) &&
    config.securePorts.every(
      (port) => Number.isInteger(port) && port > 0 && port <= 65535,
    ) &&
    Array.isArray(config.trustedProxyIps) &&
    config.trustedProxyIps.every((ip) => typeof ip === "string") &&
    !!config.platform?.pdfRender &&
    typeof config.platform.pdfRender.rendererPath === "string" &&
    !!config.platform.pdfRender.environment &&
    Object.values(config.platform.pdfRender.environment).every(
      (value) => typeof value === "string",
    ) &&
    !!config.https &&
    typeof config.https === "object"
  );
}

function isBootMessage(message: unknown): message is BootMessage {
  if (!message || typeof message !== "object") return false;
  const candidate = message as Partial<BootMessage>;
  return (
    candidate.type === "classapp:boot" && isRuntimeConfig(candidate.payload)
  );
}

async function start(config: ClassAppRuntimeConfig): Promise<void> {
  globalThis.__classappRuntimeConfig = config;
  const serverBundle = pathToFileURL(
    path.join(__dirname, "server", "main.mjs"),
  ).href;
  const { bootstrap } = (await import(
    /* @vite-ignore */
    serverBundle
  )) as typeof import("@/server/main");
  const shutdownRuntime = await bootstrap(config);
  let stopping = false;
  const stop = async (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    console.log(`[Server] ${signal}`);
    const forced = setTimeout(() => process.exit(1), 10_000);
    forced.unref();
    try {
      await shutdownRuntime();
      clearTimeout(forced);
      process.exit(0);
    } catch {
      clearTimeout(forced);
      process.exit(1);
    }
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
}

function startOrExit(config: ClassAppRuntimeConfig): void {
  start(config).catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}

if (typeof process.send === "function") {
  process.send({ type: "classapp:ready" });
  const timeout = setTimeout(() => process.exit(1), 5000);
  timeout.unref();
  process.once("message", (message: unknown) => {
    clearTimeout(timeout);
    if (!isBootMessage(message)) {
      console.error("[Server] invalid launcher boot payload");
      process.exit(1);
    }
    startOrExit(message.payload);
  });
} else {
  startOrExit(standaloneConfig());
}
