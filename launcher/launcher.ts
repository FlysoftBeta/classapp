// launcher.ts — ClassApp process manager.
// Vite compiles this source to plain CommonJS for Windows support.
// IMPORTANT: no shebang — Windows will not recognize it.
"use strict";

import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ClassAppRuntimeConfig } from "@/server/infra/runtimeConfig";
import { readBuildId } from "@/server/infra/buildIdentity";
import { UPDATE_CONFIRM_TIMEOUT_MS } from "@/server/infra/updateContract";

type PendingLifecycle = {
  action: "update" | "rollback";
  db?: string;
};

type ServerMessage =
  | { type: "classapp:ready" | "classapp:confirm" }
  | {
      type: "classapp:update" | "classapp:rollback";
      payload?: { dbBackup?: string };
    };

// ── Paths ────────────────────────────────────────────────────────────────────
const ROOT = __dirname;
const PID_FILE = path.join(ROOT, ".launcher-pid");
const CURRENT_DIR = path.join(ROOT, "current");
const STAGING_DIR = path.join(ROOT, "staging");
const APP_BACKUP_DIR = path.join(ROOT, "backup");
const DB_BACKUP_DIR = path.join(ROOT, "backups");
const DB_PATH = path.join(ROOT, "data.db");
const PENDING_UPDATE_FILE = path.join(ROOT, ".pending-update.json");
// ── Runtime state ────────────────────────────────────────────────────────────
let child: ChildProcess | null = null;
let restarting = false;
let lastStartAt = 0;
let fastCrashCount = 0;
let updateWatchdog: NodeJS.Timeout | null = null;
let pendingLifecycle: PendingLifecycle | null = null;

const FAST_CRASH_MS = 15000;
const MAX_FAST_CRASHES = 3;
const DEFAULT_PORTS = [80, 81, 82, 83, 84, 85, 86, 88];
const DEFAULT_SECURE_PORTS = [443];
const PORTS = parsePorts("CLASSAPP_PORTS", DEFAULT_PORTS);

function parsePorts(name: string, fallback: number[]) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const ports = raw
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0 && n <= 65535);
  return ports.length > 0 ? [...new Set(ports)] : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readHttpsConfig(appDir: string): ClassAppRuntimeConfig["https"] {
  const httpsDir = path.join(appDir, "https");
  const configPath = path.join(httpsDir, "config.json");
  if (!fs.existsSync(configPath)) {
    return {
      domain: null,
      certificatePath: null,
      privateKeyPath: null,
      rootCertificatePath: null,
    };
  }
  try {
    const value = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      domain?: unknown;
      certificate?: unknown;
      privateKey?: unknown;
      rootCertificate?: unknown;
    };
    const resolveFile = (name: unknown): string | null =>
      typeof name === "string" && name ? path.resolve(httpsDir, name) : null;
    const domain =
      typeof value.domain === "string" && value.domain.trim()
        ? value.domain.trim().toLowerCase()
        : null;
    return {
      domain,
      certificatePath: resolveFile(value.certificate),
      privateKeyPath: resolveFile(value.privateKey),
      rootCertificatePath: resolveFile(value.rootCertificate),
    };
  } catch (error: unknown) {
    console.error("[Launcher] HTTPS 配置无效:", errorMessage(error));
    return {
      domain: null,
      certificatePath: null,
      privateKeyPath: null,
      rootCertificatePath: null,
    };
  }
}

function buildBootPayload(appDir: string): ClassAppRuntimeConfig {
  const https = readHttpsConfig(appDir);
  const securePorts = https.domain
    ? parsePorts("CLASSAPP_SECURE_PORTS", DEFAULT_SECURE_PORTS)
    : parsePorts("CLASSAPP_SECURE_PORTS", []);
  return {
    appDir,
    dataRoot: ROOT,
    buildId: readBuildId(appDir),
    ports: PORTS,
    securePorts,
    bindHost: "0.0.0.0",
    trustedProxyIps: [],
    nodeEnv: "production",
    https,
    update: {
      enabled: true,
      stagingDir: STAGING_DIR,
      backupDir: APP_BACKUP_DIR,
    },
  };
}

// ── DB / app swap ────────────────────────────────────────────────────────────
function restoreDatabase(dbName: string): void {
  const src = path.join(DB_BACKUP_DIR, dbName);
  if (!fs.existsSync(src)) {
    throw new Error(`数据库备份不存在: ${dbName}`);
  }
  // SQLite WAL+SHM sidecars must be removed before swapping the main db.
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = DB_PATH + suffix;
    if (fs.existsSync(sidecar)) {
      try {
        fs.unlinkSync(sidecar);
      } catch {
        /* ignore */
      }
    }
  }
  fs.copyFileSync(src, DB_PATH);
  console.log(`[Launcher] 已还原数据库: ${dbName}`);
}

type PendingUpdateMetadata = { db?: string; appliedAt: number };

function writePendingUpdate(dbName?: string): void {
  fs.writeFileSync(
    PENDING_UPDATE_FILE,
    JSON.stringify({ db: dbName ?? null, appliedAt: Date.now() }),
  );
}

function readPendingUpdate(): PendingUpdateMetadata | null {
  try {
    const value = JSON.parse(fs.readFileSync(PENDING_UPDATE_FILE, "utf8")) as {
      db?: unknown;
      appliedAt?: unknown;
    };
    if (typeof value.appliedAt !== "number") return null;
    return {
      db: typeof value.db === "string" && value.db ? value.db : undefined,
      appliedAt: value.appliedAt,
    };
  } catch {
    return null;
  }
}

function readPendingUpdateDb(): string | undefined {
  return readPendingUpdate()?.db;
}

function clearPendingUpdateFile(): void {
  try {
    fs.unlinkSync(PENDING_UPDATE_FILE);
  } catch {
    /* ignore */
  }
}

function applyUpdate(dbName?: string): void {
  if (!fs.existsSync(STAGING_DIR)) {
    throw new Error("staging/ 目录不存在");
  }
  fs.rmSync(APP_BACKUP_DIR, { recursive: true, force: true });
  if (fs.existsSync(CURRENT_DIR)) {
    fs.renameSync(CURRENT_DIR, APP_BACKUP_DIR);
  }
  fs.renameSync(STAGING_DIR, CURRENT_DIR);
  writePendingUpdate(dbName);
}

function applyRollback(dbName?: string): void {
  if (!fs.existsSync(APP_BACKUP_DIR)) {
    throw new Error("backup/ 目录不存在，无法回滚");
  }
  fs.rmSync(CURRENT_DIR, { recursive: true, force: true });
  fs.renameSync(APP_BACKUP_DIR, CURRENT_DIR);

  const db = dbName ?? readPendingUpdateDb();
  if (db) {
    restoreDatabase(db);
  } else {
    console.warn("[Launcher] 未找到数据库回滚信息，仅还原应用版本");
  }
  clearPendingUpdateFile();
}

function clearBackupDir(): void {
  try {
    fs.rmSync(APP_BACKUP_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  clearPendingUpdateFile();
}

// ── Update watchdog ──────────────────────────────────────────────────────────
function armUpdateWatchdog(): void {
  // If, within 3 minutes of an update being applied, the admin hasn't sent
  // either a "confirm" or a "rollback" signal, the launcher rolls back itself.
  if (updateWatchdog) clearTimeout(updateWatchdog);
  if (!fs.existsSync(APP_BACKUP_DIR)) return;

  const metadata = readPendingUpdate();
  const remaining = metadata
    ? Math.max(0, UPDATE_CONFIRM_TIMEOUT_MS - (Date.now() - metadata.appliedAt))
    : UPDATE_CONFIRM_TIMEOUT_MS;
  const rollback = () => {
    if (!fs.existsSync(APP_BACKUP_DIR)) return;
    updateWatchdog = null;
    console.error("[Launcher] 3 分钟内未收到确认/回滚信号，正在自动回滚…");
    if (child) {
      pendingLifecycle = {
        action: "rollback",
        db: metadata?.db,
      };
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      return;
    }
    try {
      applyRollback(metadata?.db);
      fastCrashCount = 0;
      console.log("[Launcher] 超时回滚完成");
    } catch (error: unknown) {
      console.error("[Launcher] 超时回滚失败:", errorMessage(error));
    }
  };
  if (remaining === 0) {
    rollback();
    return;
  }
  updateWatchdog = setTimeout(rollback, remaining);
}

function disarmUpdateWatchdog(): void {
  if (updateWatchdog) {
    clearTimeout(updateWatchdog);
    updateWatchdog = null;
  }
}

// ── Server lifecycle ─────────────────────────────────────────────────────────
function startServer(): void {
  if (!fs.existsSync(CURRENT_DIR)) {
    console.error("[Launcher] current/ 目录不存在，无法启动");
    process.exit(1);
  }

  // If a backup directory exists at startup, an update is awaiting confirmation
  // and the watchdog must be armed.
  armUpdateWatchdog();

  console.log("[Launcher] 启动服务器…");
  lastStartAt = Date.now();
  const server = fork(path.join(CURRENT_DIR, "server.js"), [], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "production",
    },
    stdio: ["inherit", "inherit", "inherit", "ipc"],
  });
  child = server;

  const bootPayload = buildBootPayload(CURRENT_DIR);
  let bootPayloadSent = false;
  const sendBootPayload = () => {
    if (bootPayloadSent) return;
    server.send({
      type: "classapp:boot",
      payload: bootPayload,
    });
    bootPayloadSent = true;
  };

  const bootFallbackTimer = setTimeout(() => {
    if (bootPayloadSent) return;
    console.warn("[Launcher] 未收到子进程 ready，直接发送 boot 配置…");
    sendBootPayload();
  }, 1000);

  server.on("message", (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const event = message as ServerMessage;
    if (event.type === "classapp:ready") {
      clearTimeout(bootFallbackTimer);
      sendBootPayload();
      return;
    }
    if (event.type === "classapp:update") {
      pendingLifecycle = {
        action: "update",
        db: event.payload?.dbBackup,
      };
      try {
        server.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      return;
    }
    if (event.type === "classapp:rollback") {
      pendingLifecycle = {
        action: "rollback",
        db: event.payload?.dbBackup,
      };
      try {
        server.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      return;
    }
    if (event.type === "classapp:confirm") {
      disarmUpdateWatchdog();
      clearBackupDir();
    }
  });

  server.on("exit", (code: number | null) => {
    clearTimeout(bootFallbackTimer);
    child = null;
    if (restarting) {
      process.exit(0);
    }

    const signal = pendingLifecycle;
    pendingLifecycle = null;

    if (signal?.action === "update") {
      console.log("[Launcher] 收到 update 信号，正在应用更新…");
      try {
        applyUpdate(signal.db);
        fastCrashCount = 0;
        console.log("[Launcher] 更新已应用，正在重启…");
      } catch (error: unknown) {
        console.error("[Launcher] 更新失败，尝试回滚:", errorMessage(error));
        try {
          applyRollback(signal.db);
        } catch {
          /* ignore */
        }
      }
      setTimeout(startServer, 500);
      return;
    }

    if (signal?.action === "rollback") {
      console.log("[Launcher] 收到 rollback 信号，正在还原…");
      disarmUpdateWatchdog();
      try {
        applyRollback(signal.db);
        fastCrashCount = 0;
        console.log("[Launcher] 回滚完成，正在重启…");
      } catch (error: unknown) {
        console.error("[Launcher] 回滚失败:", errorMessage(error));
      }
      setTimeout(startServer, 500);
      return;
    }

    if (code !== 0) {
      const uptime = Date.now() - lastStartAt;
      fastCrashCount = uptime < FAST_CRASH_MS ? fastCrashCount + 1 : 0;
      console.log(
        `[Launcher] 服务器崩溃（退出码 ${code}，运行 ${Math.round(uptime / 1000)}s，连续 ${fastCrashCount} 次）`,
      );

      if (fastCrashCount >= MAX_FAST_CRASHES && fs.existsSync(APP_BACKUP_DIR)) {
        console.error("[Launcher] 检测到启动崩溃循环，自动回滚到上一个版本…");
        disarmUpdateWatchdog();
        try {
          applyRollback();
          console.log("[Launcher] 自动回滚完成，正在重启…");
        } catch (error: unknown) {
          console.error("[Launcher] 自动回滚失败:", errorMessage(error));
        }
        fastCrashCount = 0;
        setTimeout(startServer, 1000);
      } else {
        console.log("[Launcher] 2 秒后重启…");
        setTimeout(startServer, 2000);
      }
      return;
    }

    console.log("[Launcher] 服务器正常退出");
  });
}

// ── Shutdown ─────────────────────────────────────────────────────────────────
function shutdown(sig: NodeJS.Signals): void {
  console.log(`[Launcher] ${sig}`);
  restarting = true;
  disarmUpdateWatchdog();
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    /* ignore */
  }
  if (child) {
    try {
      child.kill(sig);
    } catch {
      /* ignore */
    }
  }
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Persist launcher PID so external admin tooling can locate the process.
try {
  fs.writeFileSync(PID_FILE, String(process.pid));
} catch {
  /* ignore */
}

startServer();
