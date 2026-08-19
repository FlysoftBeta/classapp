import { mkdirSync } from "node:fs";
import {
  projectRoot,
  worktreePath,
} from "@/scripts/paths.mjs";
import { startDevelopmentServer } from "@/server/runtime/developmentServer";

async function main(): Promise<void> {
  const appDir = process.env.CLASSAPP_APP_DIR ?? projectRoot;
  const dataRoot = process.env.CLASSAPP_DATA_ROOT ?? worktreePath("data");
  mkdirSync(dataRoot, { recursive: true });
  const port = Number(process.env.CLASSAPP_PORT ?? "3001");
  const server = await startDevelopmentServer({
    appDir,
    dataRoot,
    port,
    buildId: process.env.CLASSAPP_BUILD_ID ?? "dev",
    initialAdminPin: "123456",
  });
  console.log(`[Server] backend on http://127.0.0.1:${server.port}`);

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
