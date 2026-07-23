import fs from "fs";
import path from "path";
import type BetterSqlite3 from "better-sqlite3";
import { createDbBackup } from "@/server/infra/dbBackup";
import { ServiceError } from "@/server/services/errors";
import {
  getRuntimeConfig,
  getRuntimeController,
} from "@/server/infra/runtimeConfig";
import { extractZipToDir } from "./archive";
import {
  clearPendingUpdate,
  getPendingUpdateAt,
  setPendingUpdateAt,
} from "@/server/data/appState";

// Matches launcher.js's UPDATE_TIMEOUT_MS — admin has 3 minutes to confirm.
const ROLLBACK_TIMEOUT_MS = 3 * 60 * 1000;

let rollbackTimer: ReturnType<typeof setTimeout> | null = null;
let _db: BetterSqlite3.Database | null = null;

export function isUpdateManagerEnabled(): boolean {
  return getRuntimeConfig().update.enabled;
}

function stagingDir(): string {
  return getRuntimeConfig().update.stagingDir;
}

function backupDir(): string {
  return getRuntimeConfig().update.backupDir;
}

function clearPending(): void {
  if (_db) clearPendingUpdate(_db);
}

export function initUpdateManager(db: BetterSqlite3.Database): void {
  if (!isUpdateManagerEnabled()) return;

  _db = db;
  const appliedAtValue = getPendingUpdateAt(db);

  if (!appliedAtValue) return;

  // No backup to roll back to means we've already rolled back (or the backup
  // was lost). Clear the stale flag so we don't loop into rollback forever.
  if (!fs.existsSync(backupDir())) {
    console.log("[UpdateManager] 检测到无 backup/ 的待确认更新，清除残留标记");
    clearPending();
    return;
  }

  const appliedAt = new Date(appliedAtValue);
  const elapsed = Date.now() - appliedAt.getTime();
  const remaining = ROLLBACK_TIMEOUT_MS - elapsed;

  if (remaining <= 0) {
    console.log("[UpdateManager] 更新确认已超时，正在回滚…");
    triggerRollback();
    return;
  }

  console.log(
    `[UpdateManager] 待确认更新（${Math.ceil(remaining / 1000)}s 后自动回滚）`,
  );
  rollbackTimer = setTimeout(() => {
    console.log("[UpdateManager] 更新确认超时，正在回滚…");
    triggerRollback();
  }, remaining);
}

export function confirmUpdate(): void {
  if (!isUpdateManagerEnabled())
    throw new ServiceError("当前环境已禁用更新管理", 403);
  if (!_db) return;
  if (rollbackTimer) {
    clearTimeout(rollbackTimer);
    rollbackTimer = null;
  }
  clearPending();
  getRuntimeController()?.confirmUpdate();

  try {
    fs.rmSync(backupDir(), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  console.log("[UpdateManager] 更新已确认，备份已清除");
}

/** Manually trigger a rollback (admin "立即回滚" button). Throws if nothing to roll back to. */
export function requestRollback(db: BetterSqlite3.Database): void {
  if (!isUpdateManagerEnabled())
    throw new ServiceError("当前环境已禁用更新管理", 403);

  _db = db;
  if (!getPendingUpdateAt(db)) {
    throw new ServiceError("当前没有待确认的更新", 409);
  }
  if (!fs.existsSync(backupDir()))
    throw new ServiceError("backup/ 目录不存在，无法回滚", 409);

  if (rollbackTimer) {
    clearTimeout(rollbackTimer);
    rollbackTimer = null;
  }
  console.log("[UpdateManager] 管理员触发回滚…");
  triggerRollback();
}

export interface UpdateStatus {
  pending: boolean;
  applied_at: string | null;
  seconds_remaining: number;
  timeout_seconds: number;
  disabled: boolean;
}

export function getUpdateStatus(): UpdateStatus {
  const timeout_seconds = Math.ceil(ROLLBACK_TIMEOUT_MS / 1000);
  const disabled = !isUpdateManagerEnabled();
  if (disabled || !_db)
    return {
      pending: false,
      applied_at: null,
      seconds_remaining: 0,
      timeout_seconds,
      disabled,
    };

  const appliedAtValue = getPendingUpdateAt(_db);
  if (!appliedAtValue)
    return {
      pending: false,
      applied_at: null,
      seconds_remaining: 0,
      timeout_seconds,
      disabled: false,
    };

  const appliedAt = new Date(appliedAtValue);
  const elapsed = Date.now() - appliedAt.getTime();
  const seconds_remaining = Math.max(
    0,
    Math.ceil((ROLLBACK_TIMEOUT_MS - elapsed) / 1000),
  );
  return {
    pending: true,
    applied_at: appliedAtValue,
    seconds_remaining,
    timeout_seconds: Math.ceil(ROLLBACK_TIMEOUT_MS / 1000),
    disabled: false,
  };
}

export function setPendingUpdate(db: BetterSqlite3.Database): void {
  if (!isUpdateManagerEnabled())
    throw new ServiceError("当前环境已禁用更新管理", 403);

  const now = new Date().toISOString();
  setPendingUpdateAt(db, now);
}

function clearStagingDir(): void {
  fs.rmSync(stagingDir(), { recursive: true, force: true });
}

/** Stage a deploy zip, snapshot DB, and signal the launcher to apply the update. */
export async function deployUpdate(
  db: BetterSqlite3.Database,
  zipBytes: Uint8Array,
): Promise<void> {
  if (!isUpdateManagerEnabled())
    throw new ServiceError("当前环境已禁用更新管理", 403);

  if (zipBytes[0] !== 0x50 || zipBytes[1] !== 0x4b)
    throw new ServiceError("文件不是有效的 ZIP 格式");

  clearStagingDir();
  fs.mkdirSync(stagingDir(), { recursive: true });
  try {
    extractZipToDir(zipBytes, stagingDir());
  } catch {
    clearStagingDir();
    throw new ServiceError("解压失败，ZIP 文件可能已损坏");
  }

  const missing = [
    "client",
    "server",
    "shell.html",
    "server.js",
    "build-id.txt",
    "node_modules",
  ].find((f) => !fs.existsSync(path.join(stagingDir(), f)));
  if (missing) {
    clearStagingDir();
    throw new ServiceError(`ZIP 中缺少 ${missing}`);
  }

  const dbBackup = await createDbBackup();
  if (!dbBackup) throw new ServiceError("数据库不存在，无法创建回滚备份", 409);

  setPendingUpdate(db);
  const controller = getRuntimeController();
  if (controller) {
    controller.requestUpdate(dbBackup);
    controller.restart(1000, 0);
    return;
  }
  setTimeout(() => process.exit(0), 1000);
}

function triggerRollback(): void {
  try {
    clearPending();
  } catch {
    /* ignore */
  }
  const controller = getRuntimeController();
  if (controller) {
    controller.requestRollback();
    controller.restart(500, 0);
    return;
  }
  setTimeout(() => process.exit(0), 500);
}
