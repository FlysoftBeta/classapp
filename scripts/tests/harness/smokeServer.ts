import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createPlatformRuntimeConfig,
  setRuntimeConfig,
} from "@/server/infra/runtimeConfig";
import { projectRoot } from "@/scripts/paths.mjs";
import { ProtocolClient, ProtocolError } from "./protocolClient";
import type { ActionData } from "@/shared/protocol/actions";
import type { User } from "@/shared/types/api";

export { ProtocolClient, ProtocolError };

export type LoginSuccess = Extract<
  ActionData<"loginPinAction">,
  { user: User; token: string }
>;

export interface SmokeSession {
  dataRoot: string;
  port: number;
  buildId: string;
  admin: LoginSuccess;
  client: ProtocolClient;
  login(pin: string, target?: ProtocolClient): Promise<LoginSuccess>;
  openClient(): Promise<ProtocolClient>;
  close(): Promise<void>;
}

const ADMIN_PIN = "123456";

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address !== "object") {
    server.close();
    throw new Error("Failed to allocate an ephemeral port");
  }
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function closeHttp(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/**
 * Isolated HTTP+WebSocket development runtime. Executor workers inherit the
 * current process `--import tsx` so TypeScript entrypoints load.
 */
export async function startSmokeServer(): Promise<SmokeSession> {
  process.env.CLASSAPP_EXECUTORS = "1";
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "classapp-smoke-"));
  const port = await freePort();
  const buildId = "test";
  const config = setRuntimeConfig({
    appDir: projectRoot,
    dataRoot,
    buildId,
    ports: [port],
    securePorts: [],
    bindHost: "127.0.0.1",
    trustedProxyIps: ["127.0.0.1", "::1"],
    nodeEnv: "development",
    initialAdminPin: ADMIN_PIN,
    platform: createPlatformRuntimeConfig(projectRoot, "development"),
  });

  const [
    { createHttpHandler },
    { openCoordinatorDatabase },
    { WebSocketProtocol },
    { Coordinator },
  ] = await Promise.all([
    import("@/server/http/handler"),
    import("@/server/infra/db"),
    import("@/server/protocol/WebSocketProtocol"),
    import("@/server/runtime/coordinator"),
  ]);

  const db = openCoordinatorDatabase();
  const coordinator = new Coordinator(db, buildId);
  await coordinator.storage.start();
  await coordinator.articleUploads.reconcile();
  await coordinator.media.start();
  coordinator.teachDocuments.start();
  const backend = createServer(createHttpHandler(config, coordinator));
  const protocol = new WebSocketProtocol(buildId, coordinator);
  protocol.attach(backend);

  await new Promise<void>((resolve, reject) => {
    backend.once("error", reject);
    backend.listen(port, "127.0.0.1", resolve);
  });

  const client = new ProtocolClient(`ws://127.0.0.1:${port}/ws`);
  const hello = await client.connect();
  if (hello.buildId !== buildId) {
    throw new Error(`Unexpected hello build id ${hello.buildId}`);
  }

  const extraClients: ProtocolClient[] = [];

  async function openClient(): Promise<ProtocolClient> {
    const next = new ProtocolClient(`ws://127.0.0.1:${port}/ws`);
    await next.connect();
    extraClients.push(next);
    return next;
  }

  async function login(
    pin: string,
    target: ProtocolClient = client,
  ): Promise<LoginSuccess> {
    const result = await target.request("loginPinAction", [pin], null);
    if (!("user" in result) || !("token" in result)) {
      throw new Error(`Login did not return a session: ${JSON.stringify(result)}`);
    }
    await target.authenticate(result.user.id, result.token);
    return result;
  }

  const admin = await login(ADMIN_PIN);
  let closed = false;
  return {
    dataRoot,
    port,
    buildId,
    admin,
    client,
    login,
    openClient,
    async close() {
      if (closed) return;
      closed = true;
      await Promise.all(extraClients.map((item) => item.close()));
      await client.close();
      protocol.close();
      coordinator.teachDocuments.stop();
      await coordinator.media.stop();
      coordinator.closePool();
      await closeHttp(backend);
      db.close();
      await delay(200);
      await rm(dataRoot, { recursive: true, force: true });
    },
  };
}

export function uniqueHandle(prefix = "u"): string {
  return `${prefix}${Math.random().toString(36).slice(2, 10)}`;
}

export function uniquePin(): string {
  let pin = String(100000 + Math.floor(Math.random() * 900000));
  while (pin === ADMIN_PIN) {
    pin = String(100000 + Math.floor(Math.random() * 900000));
  }
  return pin;
}
