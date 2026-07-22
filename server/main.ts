import { createServer, type Server } from "node:http";
import {
  setRuntimeConfig,
  setRuntimeController,
  type ClassAppRuntimeConfig,
} from "@/server/infra/runtimeConfig";
import { createHttpHandler } from "@/server/http/handler";
import { WebSocketProtocol } from "@/server/protocol/WebSocketProtocol";

export async function bootstrap(
  config: ClassAppRuntimeConfig,
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
  const handler = createHttpHandler(config);
  const protocol = new WebSocketProtocol(config.buildId);
  const servers: Server[] = [];
  for (const port of config.ports) {
    const server = createServer(handler);
    protocol.attach(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, config.bindHost, () => {
        server.off("error", reject);
        console.log(`> Ready on http://localhost:${port}`);
        resolve();
      });
    });
    servers.push(server);
  }
  return async () => {
    protocol.close();
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
  };
}
