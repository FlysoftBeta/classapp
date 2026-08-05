import type BetterSqlite3 from "better-sqlite3";
import {
  deleteUserConfigValue,
  getUserConfigValue,
  upsertUserConfigValue,
  purgeUserConfigValues,
} from "@/server/data/userConfig";
import { publishUser } from "./eventBus";

function publishUserConfigChanged(
  userId: string,
  key: string,
  value: string | null,
): void {
  publishUser(userId, {
    kind: "user.config_changed",
    data: { key, value },
  });
}

export function getUserConfig(
  db: BetterSqlite3.Database,
  userId: string,
  key: string,
): string | null {
  return getUserConfigValue(db, userId, key);
}

export function setUserConfig(
  db: BetterSqlite3.Database,
  userId: string,
  key: string,
  value: string,
): void {
  upsertUserConfigValue(db, userId, key, value);
  publishUserConfigChanged(userId, key, value);
}

export function deleteUserConfig(
  db: BetterSqlite3.Database,
  userId: string,
  key: string,
): void {
  deleteUserConfigValue(db, userId, key);
  publishUserConfigChanged(userId, key, null);
}

export function purgeUserConfig(
  db: BetterSqlite3.Database,
  userId: string,
): void {
  purgeUserConfigValues(db, userId);
}

export class UserConfigService {
  constructor(private readonly db: BetterSqlite3.Database) {}

  purgeUser(userId: string): void {
    purgeUserConfig(this.db, userId);
  }
}

export function createUserConfigService(
  db: BetterSqlite3.Database,
): UserConfigService {
  return new UserConfigService(db);
}
