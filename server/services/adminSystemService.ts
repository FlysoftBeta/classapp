import { spawn } from "child_process";
import type BetterSqlite3 from "better-sqlite3";
import {
  createDbBackup,
  deleteBackup,
  listBackupFiles,
  buildBackupDownload,
} from "@/server/infra/dbBackup";
import { PublicError } from "@/server/services/incidentService";
import { createHttpsUpgradeService } from "@/server/services/httpsUpgradeService";
import type { UpdateSticky } from "@/server/runtime/sticky";

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
  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly update: UpdateSticky,
  ) {}

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
    return this.update.status();
  }

  cloudConfigChanged(): void {
    this.update.cloudConfigChanged();
  }

  async checkCloudUpdate() {
    return this.update.checkCloud();
  }

  async installCloudUpdate(): Promise<{ ok: true; message: string }> {
    await this.update.installCloud();
    return { ok: true, message: "服务器即将重启以应用云端更新" };
  }

  getHttpsStatus() {
    return createHttpsUpgradeService(this.db).getStatus();
  }

  confirmUpdate(): Promise<void> {
    return this.update.confirm();
  }

  async rollback(): Promise<{ ok: true; message: string }> {
    await this.update.rollback();
    return { ok: true, message: "服务器即将回滚并重启" };
  }

  async deployPackage(
    zipBytes: Uint8Array,
  ): Promise<{ ok: true; message: string }> {
    await this.update.deploy(zipBytes);
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
  update: UpdateSticky,
): AdminSystemService {
  return new AdminSystemService(db, update);
}
