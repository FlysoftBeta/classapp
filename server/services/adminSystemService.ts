import { spawn } from "child_process";
import type BetterSqlite3 from "better-sqlite3";
import {
  createDbBackup,
  deleteBackup,
  listBackupFiles,
} from "@/server/infra/dbBackup";
import {
  confirmUpdate,
  deployUpdate,
  getUpdateStatus,
  requestRollback,
} from "@/server/infra/updateManager";
import { ServiceError } from "@/server/services/errors";

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
    if (!(await createDbBackup())) {
      throw new ServiceError("数据库文件不存在", 404);
    }
    return this.listBackups();
  }

  deleteBackup(name: string): void {
    deleteBackup(name);
  }

  getUpdateStatus() {
    return getUpdateStatus();
  }

  confirmUpdate(): void {
    confirmUpdate();
  }

  rollback(): { ok: true; message: string } {
    requestRollback(this.db);
    return { ok: true, message: "服务器即将回滚并重启" };
  }

  async deployPackage(
    zipBytes: Uint8Array,
  ): Promise<{ ok: true; message: string }> {
    await deployUpdate(this.db, zipBytes);
    return { ok: true, message: "服务器即将重启以应用更新" };
  }

  runTool(action: AdminSystemToolAction): { ok: true; message: string } {
    if (process.platform !== "win32") {
      throw new ServiceError("仅支持 Windows", 400);
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
    throw new ServiceError("未知操作", 400);
  }
}

export function createAdminSystemService(
  db: BetterSqlite3.Database,
): AdminSystemService {
  return new AdminSystemService(db);
}
