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
    https: {
      domain: null,
      certificatePath: null,
      privateKeyPath: null,
      rootCertificatePath: null,
    },
    update: {
      enabled: false,
      stagingDir: worktreePath("staging"),
      backupDir: worktreePath("backup"),
    },
  });

  const [
    { createHttpHandler },
    { getDb },
    { WebSocketProtocol },
    { startMaintenance: startPeriodicMaintenance },
    { startOfficeDocumentMonitor },
  ] = await Promise.all([
    import("@/server/http/handler"),
    import("@/server/infra/db"),
    import("@/server/protocol/WebSocketProtocol"),
    import("@/server/services/maintenance"),
    import("@/server/services/officeDocumentMonitor"),
  ]);
  const db = getDb();
  const backend = createServer(createHttpHandler(config));
  new WebSocketProtocol("dev").attach(backend);
  const stopMaintenance = startPeriodicMaintenance(db);
  const stopOfficeDocumentMonitor = startOfficeDocumentMonitor(db);
  backend.listen(port, "127.0.0.1", () =>
    console.log(`[Server] backend on http://127.0.0.1:${port}`),
  );

  const shutdown = async () => {
    stopOfficeDocumentMonitor();
    stopMaintenance();
    backend.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
