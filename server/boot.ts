// Production runtime bootstrap. The launcher injects the complete runtime
// contract over IPC; this file intentionally contains no application logic.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ClassAppRuntimeConfig } from "@/server/infra/runtimeConfig";

interface BootMessage {
  type: "classapp:boot";
  payload: ClassAppRuntimeConfig;
}

function standaloneConfig(): ClassAppRuntimeConfig {
  const dataRoot = path.resolve(process.cwd());
  const appDir = __dirname;
  const buildIdFile = path.join(appDir, "build-id.txt");
  return {
    appDir,
    dataRoot,
    buildId: fs.existsSync(buildIdFile)
      ? fs.readFileSync(buildIdFile, "utf8").trim()
      : "dev",
    ports:
      process.env.NODE_ENV === "production"
        ? [80, 81, 82, 83, 84, 85, 86, 88]
        : [3000],
    bindHost: "0.0.0.0",
    nodeEnv: process.env.NODE_ENV ?? "production",
    initialAdminPin:
      process.env.NODE_ENV === "production" ? undefined : "123456",
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
    )
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
    console.log(`> Received ${signal}, shutting down...`);
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
      console.error("> Received invalid launcher boot payload");
      process.exit(1);
    }
    startOrExit(message.payload);
  });
} else {
  startOrExit(standaloneConfig());
}
