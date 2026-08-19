import type { Database } from "better-sqlite3";
import {
  getUserConfigVersion,
  upsertUserConfigVersion,
} from "@/server/data/userConfig";
import { publishUser } from "@/server/runtime/eventBus";

export class VersionedUserConfigService {
  constructor(private readonly db: Database) {}

  get(userId: string, keys: string[]) {
    return Object.fromEntries(
      keys.map((key) => [key, getUserConfigVersion(this.db, userId, key)]),
    );
  }

  set(userId: string, key: string, value: string, updatedAt: number) {
    const result = upsertUserConfigVersion(
      this.db,
      userId,
      key,
      value,
      updatedAt,
    );
    publishUser(userId, {
      kind: "user.config_changed",
      data: { key, value: result.value, updatedAt: result.updatedAt },
    });
    return result;
  }
}
