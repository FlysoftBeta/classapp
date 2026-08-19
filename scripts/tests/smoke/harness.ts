import crypto from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { worktreePath } from "@/scripts/paths.mjs";
import { startDevelopmentServer } from "@/server/runtime/developmentServer";
import { freePort } from "../prod-runtime.mts";
import { SmokeProtocolClient } from "./protocolClient";

export type SmokeDataMode = "fresh" | "seeded";

export interface SmokeRuntime {
  mode: SmokeDataMode;
  pin: string;
  userId: string;
  handle: string;
  username: string;
  dataRoot: string;
  client: SmokeProtocolClient;
  wsUrl: string;
  openClient(): Promise<SmokeProtocolClient>;
  close(): Promise<void>;
}

export const SMOKE_FRESH_PIN = "123456";
export const SMOKE_SEEDED_PIN = "246810";

export function smokeSeedDatabasePath(): string {
  const root = process.env.CLASSAPP_SMOKE_SEED_ROOT ?? worktreePath("data");
  return path.join(root, "data.db");
}

export function smokeSeedAvailable(): boolean {
  return existsSync(smokeSeedDatabasePath());
}

function resetRootAdminPin(
  dbPath: string,
  pin: string,
): { userId: string; handle: string } {
  const db = new Database(dbPath);
  try {
    const secret = db
      .prepare("SELECT value FROM config WHERE key = 'pin_secret'")
      .get() as { value: string } | undefined;
    if (!secret) throw new Error("Seed database is missing pin_secret");
    const root = db
      .prepare(
        `SELECT u.id AS userId, u.handle AS handle
           FROM user_admin_roles r
           JOIN users u ON u.id = r.user_id
          WHERE r.role = 'root'
          LIMIT 1`,
      )
      .get() as { userId: string; handle: string } | undefined;
    if (!root) throw new Error("Seed database has no root administrator");
    const hash = crypto
      .createHmac("sha256", secret.value)
      .update(pin)
      .digest("hex");
    db.prepare("DELETE FROM user_pins WHERE user_id = ?").run(root.userId);
    db.prepare(
      "INSERT INTO user_pins (id, user_id, pin_hash) VALUES (?, ?, ?)",
    ).run(crypto.randomUUID(), root.userId, hash);
    return root;
  } finally {
    db.close();
  }
}

async function copySeedDatabase(sourcePath: string, destPath: string): Promise<void> {
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(destPath);
  } finally {
    source.close();
  }
}

export async function startSmokeRuntime(
  mode: SmokeDataMode,
): Promise<SmokeRuntime> {
  process.env.CLASSAPP_EXECUTORS ??= "1";
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), `classapp-smoke-${mode}-`));
  mkdirSync(dataRoot, { recursive: true });
  const pin = mode === "fresh" ? SMOKE_FRESH_PIN : SMOKE_SEEDED_PIN;
  let server: Awaited<ReturnType<typeof startDevelopmentServer>> | undefined;
  let client: SmokeProtocolClient | undefined;
  try {
    if (mode === "seeded") {
      const source = smokeSeedDatabasePath();
      if (!existsSync(source)) {
        throw new Error(
          `Seeded smoke requested but ${source} does not exist. Set CLASSAPP_SMOKE_SEED_ROOT.`,
        );
      }
      await copySeedDatabase(source, path.join(dataRoot, "data.db"));
      resetRootAdminPin(path.join(dataRoot, "data.db"), pin);
    }

    const port = await freePort();
    server = await startDevelopmentServer({
      dataRoot,
      port,
      buildId: `smoke-${mode}`,
      initialAdminPin: mode === "fresh" ? pin : undefined,
    });
    const wsUrl = `ws://127.0.0.1:${port}/ws`;

    const openClient = async () => {
      const next = new SmokeProtocolClient();
      await next.connect(wsUrl);
      return next;
    };

    client = await openClient();
    const session = await client.loginWithPin(pin);
    const clients: SmokeProtocolClient[] = [client];

    return {
      mode,
      pin,
      userId: session.userId,
      handle: session.handle,
      username: session.username,
      dataRoot,
      client,
      wsUrl,
      async openClient() {
        const next = await openClient();
        clients.push(next);
        return next;
      },
      async close() {
        for (const open of clients) open.close();
        await server?.close();
        await rm(dataRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    client?.close();
    await server?.close().catch(() => undefined);
    await rm(dataRoot, { recursive: true, force: true });
    throw error;
  }
}
