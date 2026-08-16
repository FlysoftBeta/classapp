import { spawn } from "child_process";
import type BetterSqlite3 from "better-sqlite3";
import {
  createDbBackup,
  deleteBackup,
  listBackupFiles,
  buildBackupDownload,
} from "@/server/infra/dbBackup";
import { updateManager } from "@/server/infra/update/manager";
import { PublicError } from "@/server/services/incidentService";
import { createHttpsUpgradeService } from "@/server/services/httpsUpgradeService";

export type AdminSystemToolAction = "kill-wps" | "shutdown";

function runBackground(command: string, args: string[]) {
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

export class AdminSystemService {
  constructor(private readonly db: BetterSqlite3.Database) {}

  listBackups() {
    return listBackupFiles();
  }

  async createBackup() {
    if (!(await createDbBackup(this.db))) {
      throw new PublicError("数据库文件不存在");
    }
    return this.listBackups();
  }

  deleteBackup(name: string): void {
    deleteBackup(name);
  }

  downloadBackup(name: string) {
    return buildBackupDownload(name);
  }

  getUpdateStatus() {
    const status = updateManager()?.getStatus();
    return status
      ? { ...status, disabled: false }
      : {
          pending: false,
          applied_at: null,
          seconds_remaining: 0,
          timeout_seconds: 0,
          cloud_checking: false,
          cloud_installing: false,
          cloud_latest_build_id: null,
          cloud_update_available: false,
          cloud_last_checked_at: null,
          cloud_last_error: null,
          disabled: true,
        };
  }

  cloudConfigChanged(): void {
    updateManager()?.cloudConfigChanged();
  }

  async checkCloudUpdate() {
    const manager = updateManager();
    if (!manager) throw new PublicError("当前环境已禁用在线更新");
    return manager.checkCloudUpdate();
  }

  async installCloudUpdate(): Promise<{ ok: true; message: string }> {
    const manager = updateManager();
    if (!manager) throw new PublicError("当前环境已禁用在线更新");
    await manager.installCloudUpdate();
    return { ok: true, message: "服务器即将重启以应用云端更新" };
  }

  getHttpsStatus() {
    return createHttpsUpgradeService(this.db).getStatus();
  }

  confirmUpdate(): void {
    const manager = updateManager();
    if (!manager) throw new PublicError("当前环境已禁用在线更新");
    manager.confirmUpdate();
  }

  rollback(): { ok: true; message: string } {
    const manager = updateManager();
    if (!manager) throw new PublicError("当前环境已禁用在线更新");
    manager.requestRollback();
    return { ok: true, message: "服务器即将回滚并重启" };
  }

  async deployPackage(
    zipBytes: Uint8Array,
  ): Promise<{ ok: true; message: string }> {
    const manager = updateManager();
    if (!manager) throw new PublicError("当前环境已禁用在线更新");
    await manager.deployUpdate(zipBytes);
    return { ok: true, message: "服务器即将重启以应用更新" };
  }

  runTool(action: AdminSystemToolAction): { ok: true; message: string } {
    if (process.platform !== "win32") {
      throw new PublicError("仅支持 Windows");
    }
    if (action === "kill-wps") {
      runBackground("taskkill", [
        "/f",
        "/im",
        "et.exe",
        "/im",
        "wpp.exe",
        "/im",
        "wps.exe",
        "/im",
        "pdf.exe",
      ]);
      return { ok: true, message: "已发送关闭 WPS 命令" };
    }
    if (action === "shutdown") {
      runBackground("shutdown", ["/s", "/t", "0"]);
      return { ok: true, message: "已发送关机命令" };
    }
    throw new PublicError("未知操作");
  }
}

export function createAdminSystemService(
  db: BetterSqlite3.Database,
): AdminSystemService {
  return new AdminSystemService(db);
}
