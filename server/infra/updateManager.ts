import fs from "fs";
import type BetterSqlite3 from "better-sqlite3";
import { createDbBackup } from "@/server/infra/dbBackup";
import { BUILD_ID } from "@/server/infra/env";
import {
  attachSuppressedError,
  PublicError,
} from "@/server/services/incidentService";
import {
  runtimeController,
  UpdateRuntimeConfig,
} from "@/server/infra/runtimeConfig";
import { extractZipToDir } from "./archive";
import {
  clearPendingUpdate,
  getPendingUpdateAt,
  setPendingUpdateAt,
} from "@/server/data/appState";
import { UPDATE_CONFIRM_TIMEOUT_MS } from "./updateContract";
import { recordContainedServerIncident } from "@/server/services/incidentService";

// State machine: an update is either not tracked at all (idle), or a deploy
// has been applied and is awaiting the launcher watchdog's confirmation
// (pending). There is no separate "rolling back" state because a rollback
// clears the pending flag synchronously before restarting the process.
type UpdateManagerState =
  { status: "idle" } | { status: "pending"; appliedAt: string };

export interface UpdateStatus {
  pending: boolean;
  applied_at: string | null;
  seconds_remaining: number;
  timeout_seconds: number;
}

let _updateManager: UpdateManager | null = null;

export function updateManager(): UpdateManager | null {
  return _updateManager;
}

export function setUpdateManager(updateManager: UpdateManager) {
  _updateManager = updateManager;
}

export class UpdateManager {
  private state: UpdateManagerState = { status: "idle" };

  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly config: UpdateRuntimeConfig,
  ) {
    const appliedAtValue = getPendingUpdateAt(this.db);

    if (!appliedAtValue) {
      this.state = { status: "idle" };
      return;
    }

    // No backup to roll back to means we've already rolled back (or the
    // backup was lost). Clear the stale flag so we don't loop into rollback
    // forever.
    if (!fs.existsSync(this.config.backupDir)) {
      console.log(
        "[UpdateManager] 检测到无 backup/ 的待确认更新，清除残留标记",
      );
      this.clearPending();
      return;
    }

    this.state = { status: "pending", appliedAt: appliedAtValue };
    const elapsed = Date.now() - new Date(appliedAtValue).getTime();
    const remaining = Math.max(0, UPDATE_CONFIRM_TIMEOUT_MS - elapsed);
    console.log(
      `[UpdateManager] 待确认更新（launcher watchdog 剩余约 ${Math.ceil(remaining / 1000)}s）`,
    );
  }

  confirmUpdate(): void {
    this.clearPending();
    runtimeController()?.confirmUpdate();
    console.log("[UpdateManager] 更新已确认，launcher 将清除应用备份");
  }

  requestRollback(): void {
    if (this.state.status !== "pending") {
      throw new PublicError("当前没有待确认的更新");
    }
    if (!fs.existsSync(this.config.backupDir)) {
      throw new PublicError("backup/ 目录不存在，无法回滚");
    }

    console.log("[UpdateManager] 管理员触发回滚…");
    this.triggerRollback();
  }

  getStatus(): UpdateStatus {
    const timeout_seconds = Math.ceil(UPDATE_CONFIRM_TIMEOUT_MS / 1000);

    if (this.state.status === "idle") {
      return {
        pending: false,
        applied_at: null,
        seconds_remaining: 0,
        timeout_seconds,
      };
    }

    const elapsed = Date.now() - new Date(this.state.appliedAt).getTime();
    const seconds_remaining = Math.max(
      0,
      Math.ceil((UPDATE_CONFIRM_TIMEOUT_MS - elapsed) / 1000),
    );
    return {
      pending: true,
      applied_at: this.state.appliedAt,
      seconds_remaining,
      timeout_seconds,
    };
  }

  setPendingUpdate(): void {
    const now = new Date().toISOString();
    setPendingUpdateAt(this.db, now);
    this.state = { status: "pending", appliedAt: now };
  }

  async deployUpdate(zipBytes: Uint8Array): Promise<void> {
    // staging/ belongs to the pending deployment. Remove any stale contents
    // left by an interrupted or failed previous deployment before extracting
    // the new update.
    fs.rmSync(this.config.stagingDir, { recursive: true, force: true });
    fs.mkdirSync(this.config.stagingDir, { recursive: true });

    try {
      extractZipToDir(zipBytes, this.config.stagingDir);
    } catch (error) {
      // A partially extracted staging tree must never be consumed by the
      // launcher. Best-effort cleanup while preserving the extraction error.
      try {
        fs.rmSync(this.config.stagingDir, {
          recursive: true,
          force: true,
        });
      } catch (cleanupError) {
        attachSuppressedError(error, cleanupError);
      }
      throw error;
    }

    // Keep staging/ intact after successful extraction. The launcher/runtime
    // controller consumes it after the process exits.
    const dbBackup = await createDbBackup();
    if (!dbBackup) {
      // No deployment will be requested, so the successfully extracted but
      // now unusable staging tree should not be left behind.
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

  private clearPending(): void {
    if (this.db) clearPendingUpdate(this.db);
    this.state = { status: "idle" };
  }

  private triggerRollback(): void {
    try {
      this.clearPending();
    } catch (error) {
      // Rollback must continue even if bookkeeping fails, but the failure is durable.
      recordContainedServerIncident(this.db, BUILD_ID, error, {
        component: "update-manager",
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
