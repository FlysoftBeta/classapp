import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import {
  createPlatformRuntimeConfig,
  setRuntimeConfig,
} from "@/server/infra/runtimeConfig";
import { projectRoot, worktreePath } from "@/scripts/paths.mjs";

async function main(): Promise<void> {
  const appDir = process.env.CLASSAPP_APP_DIR ?? projectRoot;
  const dataRoot = process.env.CLASSAPP_DATA_ROOT ?? worktreePath("data");
  mkdirSync(dataRoot, { recursive: true });
  const port = Number(process.env.CLASSAPP_PORT ?? "3001");
  const config = setRuntimeConfig({
    appDir,
    dataRoot,
    buildId: process.env.CLASSAPP_BUILD_ID ?? "dev",
    ports: [port],
    securePorts: [],
    bindHost: "127.0.0.1",
    trustedProxyIps: ["127.0.0.1", "::1"],
    nodeEnv: "development",
    initialAdminPin: "123456",
    platform: createPlatformRuntimeConfig(appDir, "development"),
  });

  const [
    { createHttpHandler },
    { openCoordinatorDatabase },
    { WebSocketProtocol },
    { Coordinator },
    { startMaintenance },
    { reconcileStaleAiWorkspaces },
  ] = await Promise.all([
    import("@/server/http/handler"),
    import("@/server/infra/db"),
    import("@/server/protocol/WebSocketProtocol"),
    import("@/server/runtime/coordinator"),
    import("@/server/services/maintenance"),
    import("@/server/services/ai/aiWorkspace"),
  ]);
  const db = openCoordinatorDatabase();
  const coordinator = new Coordinator(db, config.buildId);
  await coordinator.storage.start();
  await coordinator.articleUploads.reconcile();
  await reconcileStaleAiWorkspaces(db, coordinator.storage.blobs);
  await coordinator.media.start();
  coordinator.teachDocuments.start();
  const backend = createServer(createHttpHandler(config, coordinator));
  new WebSocketProtocol("dev", coordinator).attach(backend);
  const stopMaintenance = startMaintenance(db, coordinator);
  backend.listen(port, "127.0.0.1", () =>
    console.log(`[Server] backend on http://127.0.0.1:${port}`),
  );

  const shutdown = async () => {
    stopMaintenance();
    coordinator.teachDocuments.stop();
    await coordinator.media.stop();
    coordinator.closePool();
    backend.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
