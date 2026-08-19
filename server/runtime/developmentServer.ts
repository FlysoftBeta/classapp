import { mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import {
  createPlatformRuntimeConfig,
  setRuntimeConfig,
  type RuntimeConfig,
} from "@/server/infra/runtimeConfig";
import { projectRoot } from "@/scripts/paths.mjs";
import type { Coordinator } from "@/server/runtime/coordinator";
import type { WebSocketProtocol } from "@/server/protocol/WebSocketProtocol";

export interface DevelopmentServerOptions {
  dataRoot: string;
  port: number;
  appDir?: string;
  buildId?: string;
  initialAdminPin?: string;
  bindHost?: string;
}

export interface DevelopmentServer {
  readonly port: number;
  readonly dataRoot: string;
  readonly buildId: string;
  readonly config: RuntimeConfig;
  close(): Promise<void>;
}

/**
 * Start the development HTTP/WebSocket backend against an isolated data root.
 * Runtime config must be installed before Coordinator/env modules load.
 */
export async function startDevelopmentServer(
  options: DevelopmentServerOptions,
): Promise<DevelopmentServer> {
  mkdirSync(options.dataRoot, { recursive: true });
  const appDir = options.appDir ?? projectRoot;
  const bindHost = options.bindHost ?? "127.0.0.1";
  const config = setRuntimeConfig({
    appDir,
    dataRoot: options.dataRoot,
    buildId: options.buildId ?? "dev",
    ports: [options.port],
    securePorts: [],
    bindHost,
    trustedProxyIps: ["127.0.0.1", "::1"],
    nodeEnv: "development",
    initialAdminPin: options.initialAdminPin,
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
  const coordinator: Coordinator = new Coordinator(db, config.buildId);
  await coordinator.storage.start();
  await coordinator.articleUploads.reconcile();
  await reconcileStaleAiWorkspaces(db, coordinator.storage.blobs);
  await coordinator.media.start();
  coordinator.teachDocuments.start();
  const backend: Server = createServer(createHttpHandler(config, coordinator));
  const protocol: WebSocketProtocol = new WebSocketProtocol(
    config.buildId,
    coordinator,
  );
  protocol.attach(backend);
  const stopMaintenance = startMaintenance(db, coordinator);

  await new Promise<void>((resolve, reject) => {
    backend.once("error", reject);
    backend.listen(options.port, bindHost, () => resolve());
  });

  let closed = false;
  return {
    port: options.port,
    dataRoot: options.dataRoot,
    buildId: config.buildId,
    config,
    async close() {
      if (closed) return;
      closed = true;
      stopMaintenance();
      protocol.close();
      coordinator.teachDocuments.stop();
      await coordinator.media.stop();
      await coordinator.closePool();
      await new Promise<void>((resolve, reject) => {
        backend.close((error) => (error ? reject(error) : resolve()));
      });
      db.close();
    },
  };
}
