import type { Database } from "better-sqlite3";
import { USER_CONFIG } from "@/shared/userConfig/keys";
import { getUserConfig, setUserConfig } from "@/server/services/userConfig";

export interface NotificationConfig {
  doNotDisturb: boolean;
}

function parseDoNotDisturb(value: string | null): boolean {
  return value === "true";
}

export class NotificationConfigService {
  constructor(private readonly db: Database) {}

  get(userId: string): NotificationConfig {
    return {
      doNotDisturb: parseDoNotDisturb(
        getUserConfig(this.db, userId, USER_CONFIG.DO_NOT_DISTURB),
      ),
    };
  }

  setDoNotDisturb(userId: string, enabled: boolean): NotificationConfig {
    setUserConfig(this.db, userId, USER_CONFIG.DO_NOT_DISTURB, String(enabled));
    return this.get(userId);
  }
}

export function createNotificationConfigService(
  db: Database,
): NotificationConfigService {
  return new NotificationConfigService(db);
}
