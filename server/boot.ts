// Production runtime bootstrap invoked via launcher
import path from "node:path";
import { pathToFileURL } from "node:url";
import { type RuntimeConfig } from "@/server/infra/runtimeConfig";

interface BootMessage {
  type: "classapp:boot";
  payload: RuntimeConfig;
}

async function start(config: RuntimeConfig): Promise<void> {
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
process.once("message", (message: BootMessage) => {
  clearTimeout(timeout);
  startOrExit(message.payload);
});
