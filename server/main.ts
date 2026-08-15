import fs from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createSecureServer } from "node:https";
import {
  setRuntimeConfig,
  setRuntimeController,
  type RuntimeConfig,
} from "@/server/infra/runtimeConfig";
import { createHttpHandler } from "@/server/http/handler";
import { getDb } from "@/server/infra/db";
import { WebSocketProtocol } from "@/server/protocol/WebSocketProtocol";
import { startMaintenance } from "@/server/services/maintenance";
import { setUpdateManager, UpdateManager } from "./infra/update/manager";
import { Runtime } from "@/server/runtime/runtime";

export async function bootstrap(
  config: RuntimeConfig,
): Promise<() => Promise<void>> {
  setRuntimeConfig(config);
  setRuntimeController({
    requestUpdate: (dbBackup) =>
      process.send?.({ type: "classapp:update", payload: { dbBackup } }),
    requestRollback: (dbBackup) =>
      process.send?.({ type: "classapp:rollback", payload: { dbBackup } }),
    confirmUpdate: () => process.send?.({ type: "classapp:confirm" }),
    restart: (delayMs = 0, exitCode = 0) => {
      setTimeout(() => process.exit(exitCode), delayMs);
    },
  });
  const db = getDb();
  const runtime = new Runtime(db, config.buildId);
  if (config.update) setUpdateManager(new UpdateManager(db, config.update));
  const protocol = new WebSocketProtocol(config.buildId, runtime);
  const stopMaintenance = startMaintenance(db);
  const servers: Server[] = [];
  const listen = async (
    server: Server,
    protocolName: "http" | "https",
    port: number,
  ) => {
    protocol.attach(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, config.bindHost, () => {
        server.off("error", reject);
        console.log(`[Server] ${protocolName}://localhost:${port}`);
        resolve();
      });
    });
    servers.push(server);
  };
  for (const port of config.ports) {
    await listen(
      createServer(createHttpHandler(config, runtime, { secure: false })),
      "http",
      port,
    );
  }
  if (config.securePorts.length > 0) {
    if (!config.https) {
      throw new Error("已配置 SECURE_PORTS，但部署包中缺少 HTTPS 证书或私钥");
    }
    const tls = {
      cert: fs.readFileSync(config.https.certificatePath),
      key: fs.readFileSync(config.https.privateKeyPath),
    };
    for (const port of config.securePorts) {
      await listen(
        createSecureServer(
          tls,
          createHttpHandler(config, runtime, { secure: true }),
        ),
        "https",
        port,
      );
    }
  }
  return async () => {
    setUpdateManager(null);
    stopMaintenance();
    protocol.close();
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
  };
}
