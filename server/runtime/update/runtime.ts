import fs from "node:fs";
import type BetterSqlite3 from "better-sqlite3";
import { createDbBackup } from "@/server/infra/dbBackup";
import { BUILD_ID } from "@/server/infra/env";
import {
  attachSuppressedError,
  PublicError,
  recordContainedServerIncident,
} from "@/server/services/incidentService";
import {
  runtimeController,
  type UpdateRuntimeConfig,
} from "@/server/infra/runtimeConfig";
import { extractZipToDir } from "@/server/infra/archive";
import {
  clearPendingUpdate,
  getCloudUpdateConfig,
  getPendingUpdateAt,
  setPendingUpdateAt,
} from "@/server/data/appState";
import { UPDATE_CONFIRM_TIMEOUT_MS } from "./contract";
import {
  downloadCloudUpdate,
  fetchCloudUpdateManifest,
  type CloudUpdateManifest,
} from "./cloud";

const AUTO_CHECK_INTERVAL_MS = 15 * 60 * 1000;

type UpdateRuntimeState =
  { status: "idle" } | { status: "pending"; appliedAt: string };

export interface UpdateStatus {
  pending: boolean;
  applied_at: string | null;
  seconds_remaining: number;
  timeout_seconds: number;
  cloud_checking: boolean;
  cloud_installing: boolean;
  cloud_latest_build_id: string | null;
  cloud_update_available: boolean;
  cloud_last_checked_at: string | null;
  cloud_last_error: string | null;
}

export type UpdateStatusView = UpdateStatus & { disabled: boolean };

export function disabledUpdateStatus(): UpdateStatusView {
  return {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class UpdateRuntime {
  private state: UpdateRuntimeState = { status: "idle" };
  private checkTimer: NodeJS.Timeout | null = null;
  private initialCheckTimer: NodeJS.Timeout | null = null;
  private cloudChecking = false;
  private cloudInstalling = false;
  private latestManifest: CloudUpdateManifest | null = null;
  private lastCheckedAt: string | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly config: UpdateRuntimeConfig,
  ) {
    const appliedAtValue = getPendingUpdateAt(this.db);
    if (!appliedAtValue) return;
    if (!fs.existsSync(this.config.backupDir)) {
      console.log(
        "[UpdateRuntime] 检测到无 backup/ 的待确认更新，清除残留标记",
      );
      this.clearPending();
      return;
    }
    this.state = { status: "pending", appliedAt: appliedAtValue };
    const elapsed = Date.now() - new Date(appliedAtValue).getTime();
    const remaining = Math.max(0, UPDATE_CONFIRM_TIMEOUT_MS - elapsed);
    console.log(
      `[UpdateRuntime] 待确认更新（launcher watchdog 剩余约 ${Math.ceil(remaining / 1000)}s）`,
    );
  }

  start(): void {
    if (this.checkTimer) return;
    this.checkTimer = setInterval(
      () => void this.runAutomaticCheck(),
      AUTO_CHECK_INTERVAL_MS,
    );
    this.checkTimer.unref();
    this.initialCheckTimer = setTimeout(() => {
      this.initialCheckTimer = null;
      void this.runAutomaticCheck();
    }, 10_000);
    this.initialCheckTimer.unref();
  }

  stop(): void {
    if (this.checkTimer) clearInterval(this.checkTimer);
    if (this.initialCheckTimer) clearTimeout(this.initialCheckTimer);
    this.checkTimer = null;
    this.initialCheckTimer = null;
  }

  cloudConfigChanged(): void {
    this.latestManifest = null;
    const cloud = getCloudUpdateConfig(this.db);
    if (cloud.cloud_deploy_enabled && cloud.update_auto_check) {
      void this.runAutomaticCheck();
    }
  }

  confirmUpdate(): void {
    this.clearPending();
    runtimeController()?.confirmUpdate();
    console.log("[UpdateRuntime] 更新已确认，launcher 将清除应用备份");
  }

  requestRollback(): void {
    if (this.state.status !== "pending") {
      throw new PublicError("当前没有待确认的更新");
    }
    if (!fs.existsSync(this.config.backupDir)) {
      throw new PublicError("backup/ 目录不存在，无法回滚");
    }
    console.log("[UpdateRuntime] 管理员触发回滚…");
    this.triggerRollback();
  }

  getStatus(): UpdateStatus {
    const timeout_seconds = Math.ceil(UPDATE_CONFIRM_TIMEOUT_MS / 1000);
    const base = {
      cloud_checking: this.cloudChecking,
      cloud_installing: this.cloudInstalling,
      cloud_latest_build_id: this.latestManifest?.buildId ?? null,
      cloud_update_available:
        this.latestManifest !== null &&
        this.latestManifest.buildId !== BUILD_ID,
      cloud_last_checked_at: this.lastCheckedAt,
      cloud_last_error: this.lastError,
    };
    if (this.state.status === "idle") {
      return {
        pending: false,
        applied_at: null,
        seconds_remaining: 0,
        timeout_seconds,
        ...base,
      };
    }
    const elapsed = Date.now() - new Date(this.state.appliedAt).getTime();
    return {
      pending: true,
      applied_at: this.state.appliedAt,
      seconds_remaining: Math.max(
        0,
        Math.ceil((UPDATE_CONFIRM_TIMEOUT_MS - elapsed) / 1000),
      ),
      timeout_seconds,
      ...base,
    };
  }

  setPendingUpdate(): void {
    const now = new Date().toISOString();
    setPendingUpdateAt(this.db, now);
    this.state = { status: "pending", appliedAt: now };
  }

  async deployUpdate(zipBytes: Uint8Array): Promise<void> {
    if (this.state.status === "pending") {
      throw new PublicError("上一更新仍待确认");
    }
    fs.rmSync(this.config.stagingDir, { recursive: true, force: true });
    fs.mkdirSync(this.config.stagingDir, { recursive: true });
    try {
      extractZipToDir(zipBytes, this.config.stagingDir);
    } catch (error) {
      try {
        fs.rmSync(this.config.stagingDir, { recursive: true, force: true });
      } catch (cleanupError) {
        attachSuppressedError(error, cleanupError);
      }
      throw error;
    }

    const dbBackup = await createDbBackup(this.db);
    if (!dbBackup) {
      fs.rmSync(this.config.stagingDir, { recursive: true, force: true });
      throw new PublicError("数据库不存在，无法创建回滚备份");
    }
    this.setPendingUpdate();
    const controller = runtimeController();
    if (controller) {
      controller.requestUpdate(dbBackup);
      controller.restart(1000, 0);
      return;
    }
    setTimeout(() => process.exit(0), 1000);
  }

  async checkCloudUpdate(): Promise<{
    build_id: string;
    update_available: boolean;
  }> {
    const cloud = getCloudUpdateConfig(this.db);
    if (!cloud.cloud_deploy_enabled) {
      throw new PublicError("云端部署未开启");
    }
    if (!cloud.update_manifest_url) {
      throw new PublicError("尚未设置 Manifest 链接");
    }
    if (this.state.status === "pending") {
      throw new PublicError("当前更新仍待确认");
    }
    if (this.cloudChecking) throw new PublicError("正在检查云端更新");
    if (this.cloudInstalling) throw new PublicError("正在安装云端更新");

    this.cloudChecking = true;
    this.lastError = null;
    try {
      const manifest = await fetchCloudUpdateManifest(
        cloud.update_manifest_url,
      );
      this.latestManifest = manifest;
      this.lastCheckedAt = new Date().toISOString();
      return {
        build_id: manifest.buildId,
        update_available: manifest.buildId !== BUILD_ID,
      };
    } catch (error) {
      this.captureCloudFailure(error, "cloud-check");
      throw new PublicError(
        `检查云端更新失败：${errorMessage(error)}`,
        "Cloud update check failed",
        error,
      );
    } finally {
      this.cloudChecking = false;
    }
  }

  async installCloudUpdate(): Promise<void> {
    await this.checkCloudUpdate();
    const manifest = this.latestManifest;
    if (!manifest) throw new PublicError("未找到云端更新");
    if (manifest.buildId === BUILD_ID)
      throw new PublicError("当前已是最新版本");
    if (this.cloudInstalling) throw new PublicError("正在安装云端更新");
    if (this.state.status === "pending")
      throw new PublicError("当前更新仍待确认");

    this.cloudInstalling = true;
    this.lastError = null;
    try {
      const archive = await downloadCloudUpdate(manifest);
      await this.deployUpdate(archive);
    } catch (error) {
      this.captureCloudFailure(error, "cloud-install");
      if (error instanceof PublicError) throw error;
      throw new PublicError(
        `安装云端更新失败：${errorMessage(error)}`,
        "Cloud update installation failed",
        error,
      );
    } finally {
      this.cloudInstalling = false;
    }
  }

  private async runAutomaticCheck(): Promise<void> {
    const cloud = getCloudUpdateConfig(this.db);
    if (
      !cloud.cloud_deploy_enabled ||
      !cloud.update_auto_check ||
      !cloud.update_manifest_url ||
      this.cloudChecking ||
      this.cloudInstalling ||
      this.state.status === "pending"
    ) {
      return;
    }
    try {
      await this.checkCloudUpdate();
    } catch {
      // checkCloudUpdate records the diagnostic and keeps it in status.
    }
  }

  private captureCloudFailure(error: unknown, phase: string): void {
    this.lastCheckedAt = new Date().toISOString();
    this.lastError = errorMessage(error);
    console.error("[UpdateRuntime] 云端更新失败:", this.lastError);
    recordContainedServerIncident(this.db, BUILD_ID, error, {
      component: "update",
      phase,
    });
  }

  private clearPending(): void {
    clearPendingUpdate(this.db);
    this.state = { status: "idle" };
  }

  private triggerRollback(): void {
    try {
      this.clearPending();
    } catch (error) {
      recordContainedServerIncident(this.db, BUILD_ID, error, {
        component: "update",
        phase: "clear-pending-before-rollback",
      });
    }
    const controller = runtimeController();
    if (controller) {
      controller.requestRollback();
      controller.restart(500, 0);
      return;
    }
    setTimeout(() => process.exit(0), 500);
  }
}
