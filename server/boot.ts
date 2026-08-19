// Production runtime bootstrap invoked via launcher
import path from "node:path";
import { pathToFileURL } from "node:url";
import { type RuntimeConfig } from "@/server/infra/runtimeConfig";

interface BootMessage {
  type: "classapp:boot";
  payload: RuntimeConfig;
}

function isBootMessage(message: unknown): message is BootMessage {
  if (!message || typeof message !== "object") return false;
  const value = message as { type?: unknown; payload?: unknown };
  return (
    value.type === "classapp:boot" &&
    value.payload !== null &&
    typeof value.payload === "object"
  );
}

function assertBootConfig(config: RuntimeConfig): void {
  if (
    !config.appDir ||
    !config.dataRoot ||
    !config.buildId ||
    !config.nodeEnv
  ) {
    throw new Error("boot 配置缺少 appDir/dataRoot/buildId/nodeEnv");
  }
  if (config.nodeEnv === "production" && !config.update) {
    console.warn("[Server] boot 配置缺少 update，生产环境更新管理器将保持禁用");
  }
}

async function start(config: RuntimeConfig): Promise<void> {
  assertBootConfig(config);
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
    } catch (error) {
      clearTimeout(forced);
      console.error("[Server] graceful shutdown failed", error);
      process.exit(1);
    }
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
}

function startOrExit(config: RuntimeConfig): void {
  start(config).catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}

process.send!({ type: "classapp:ready" });
const timeout = setTimeout(() => process.exit(1), 5000);
timeout.unref();
const onMessage = (message: unknown) => {
  if (!isBootMessage(message)) return;
  process.off("message", onMessage);
  clearTimeout(timeout);
  startOrExit(message.payload);
};
process.on("message", onMessage);
