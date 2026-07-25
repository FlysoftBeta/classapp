import path from "node:path";
import { createServer } from "node:http";
import { setRuntimeConfig } from "@/server/infra/runtimeConfig";

async function main(): Promise<void> {
  const root = process.cwd();
  const appDir = process.env.CLASSAPP_APP_DIR ?? root;
  const dataRoot = process.env.CLASSAPP_DATA_ROOT ?? root;
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
    https: {
      domain: null,
      certificatePath: null,
      privateKeyPath: null,
      rootCertificatePath: null,
    },
    update: {
      enabled: false,
      stagingDir: path.join(root, "staging"),
      backupDir: path.join(root, "backup"),
    },
  });

  const [{ createHttpHandler }, { WebSocketProtocol }] = await Promise.all([
    import("@/server/http/handler"),
    import("@/server/protocol/WebSocketProtocol"),
  ]);
  const backend = createServer(createHttpHandler(config));
  new WebSocketProtocol("dev").attach(backend);
  backend.listen(port, "127.0.0.1", () =>
    console.log(`[Server] backend on http://127.0.0.1:${port}`),
  );

  const shutdown = async () => {
    backend.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
