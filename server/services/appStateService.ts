import type BetterSqlite3 from "better-sqlite3";
import type {
  AppDisableReason,
  AppDisableState,
  User,
} from "@/shared/types/api";
import {
  IDLE_LOCK_TIMEOUT_MINUTES,
  getClientLastActiveAt,
  getIdleLockEnabled,
  getSystemLocked,
  getMinutesSinceTimestamp,
  setIdleLockEnabled,
  setSystemLocked,
  touchActivity,
} from "@/server/data/appState";
import { isClientKonamiLocked } from "@/server/data/clients";
import { getUserBanStatus } from "@/server/data/users";
import { publishSystem } from "@/server/services/eventBus";
import { hasFeature } from "@/shared/features";

export { IDLE_LOCK_TIMEOUT_MINUTES } from "@/server/data/appState";
export type { AppDisableReason };

export interface AppStateSnapshot {
  v: 1;
  konami_locked: boolean;
  session_valid: boolean;
  user: User | null;
  app: AppDisableState;
  flags: {
    idle_lock_enabled: boolean;
    system_locked: boolean;
  };
}

export class AppStateService {
  constructor(private readonly db: BetterSqlite3.Database) {}

  getConfig(): { idle_lock_enabled: boolean; system_locked: boolean } {
    return {
      idle_lock_enabled: getIdleLockEnabled(this.db),
      system_locked: getSystemLocked(this.db),
    };
  }

  updateConfig(input: {
    idle_lock_enabled?: boolean;
    system_locked?: boolean;
  }): { idle_lock_enabled: boolean; system_locked: boolean } {
    if (input.idle_lock_enabled !== undefined) {
      setIdleLockEnabled(this.db, input.idle_lock_enabled);
      publishSystem({
        kind: "system.lock_changed",
        data: { idle_lock_enabled: input.idle_lock_enabled },
      });
    }
    if (input.system_locked !== undefined) {
      setSystemLocked(this.db, input.system_locked);
      publishSystem({
        kind: "system.lock_changed",
        data: { system_locked: input.system_locked },
      });
    }
    return this.getConfig();
  }

  snapshotAnonymous(clientId: string): AppStateSnapshot {
    const { konami_locked } = isClientKonamiLocked(this.db, clientId);
    return {
      v: 1,
      konami_locked,
      session_valid: false,
      user: null,
      app: { disabled: false, reason: null },
      flags: this.getConfig(),
    };
  }

  snapshotAuthenticated(
    user: User,
    clientId: string,
    opts: { touch?: boolean } = {},
  ): AppStateSnapshot {
    if (opts.touch !== false) {
      touchActivity(this.db, clientId);
    }

    const { konami_locked } = isClientKonamiLocked(this.db, clientId);
    return {
      v: 1,
      konami_locked,
      session_valid: true,
      user,
      app: this.computeAppDisabled(user, clientId),
      flags: this.getConfig(),
    };
  }

  private computeAppDisabled(user: User, clientId: string): AppDisableState {
    const ban = getUserBanStatus(this.db, user.id);
    if (ban.banned) {
      return {
        disabled: true,
        reason: "banned",
        banned_until: ban.banned_until,
        username: user.username,
      };
    }

    if (!hasFeature(user, "admin") && getSystemLocked(this.db)) {
      return { disabled: true, reason: "system_locked" };
    }

    if (getIdleLockEnabled(this.db)) {
      const lastAt = getClientLastActiveAt(this.db, clientId);
      if (!lastAt) {
        return { disabled: true, reason: "idle" };
      }
      const minutes = getMinutesSinceTimestamp(this.db, lastAt);
      if (minutes > IDLE_LOCK_TIMEOUT_MINUTES) {
        return { disabled: true, reason: "idle" };
      }
    }

    return { disabled: false, reason: null };
  }
}

export function createAppStateService(
  db: BetterSqlite3.Database,
): AppStateService {
  return new AppStateService(db);
}
