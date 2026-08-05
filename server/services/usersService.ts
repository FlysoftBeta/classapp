import type BetterSqlite3 from "better-sqlite3";
import { hashPin } from "@/server/infra/auth";
import { ghostPinHashExists } from "@/server/data/ghostUsers";
import {
  countUsers,
  deleteUserById,
  deleteUserSessions,
  findUserIdByHandle,
  findUserIdByHandleExcept,
  findUserPinOwnerId,
  findUserPinOwnerIdExcept,
  getUserBanStatus,
  getUserMuteStatus,
  getUser,
  insertNewUser,
  replaceUserPins,
  searchUsers,
  updateUserBanUntil,
  updateUserHandle,
  updateUserMuted,
  updateUserRole,
  updateUserFeatureMask,
  updateUserUsername,
  userExists,
  userHasPinHash,
  revokeUserCredentials,
} from "@/server/data/users";
import { ServiceError } from "./errors";
import { toDbTimestamp } from "@/shared/time";
import { publishUser } from "./eventBus";
import type { User } from "@/shared/types/api";
import { DEFAULT_FEATURE_MASK, isValidFeatureMask } from "@/shared/features";
import { insertDeletedUser } from "@/server/data/deletedUsers";
import { createArticleService } from "./articlesService";
import { createWordsService } from "./wordsService";

export interface UserServiceDeps {
  createId: () => string;
  hashPinValue: (pin: string) => string;
  now: () => number;
  publishUserEvent: typeof publishUser;
}

const defaultDeps: UserServiceDeps = {
  createId: () => crypto.randomUUID(),
  hashPinValue: hashPin,
  now: () => Date.now(),
  publishUserEvent: publishUser,
};

export interface CreateUserParams {
  handle?: string;
  username?: string;
  pin?: string;
  feature_mask?: number;
}

export interface UpdateUserParams {
  handle?: string;
  username?: string;
  pin?: string;
  feature_mask?: number;
}

export interface UpdateSelfProfileParams {
  handle?: string;
  username?: string;
}

export interface ResetPinParams {
  current_pin: string;
  new_pins: string[];
}

export type UserRemovalMode = "purge" | "deactivate";

export class UserService {
  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly deps: UserServiceDeps,
  ) {}

  private assertPinHashAvailable(
    pinHash: string,
    excludeUserId?: string,
  ): void {
    const userConflict = excludeUserId
      ? findUserPinOwnerIdExcept(this.db, pinHash, excludeUserId)
      : findUserPinOwnerId(this.db, pinHash);
    if (userConflict || ghostPinHashExists(this.db, pinHash)) {
      throw new ServiceError("该 PIN 已被使用", 409);
    }
  }

  list(q = "", offset = 0): { users: User[]; total: number } {
    return {
      users: searchUsers(this.db, q, offset),
      total: countUsers(this.db, q),
    };
  }

  get(userId: string): User {
    const user = getUser(this.db, userId);
    if (!user) {
      throw new ServiceError("干员不存在", 404);
    }
    return user;
  }

  create(params: CreateUserParams): User {
    if (!params.handle || !/^[a-zA-Z0-9_]{1,20}$/.test(params.handle)) {
      throw new ServiceError("ID 只能包含字母、数字、下划线，最多 20 位");
    }
    if (!params.pin || !/^\d{6}$/.test(params.pin)) {
      throw new ServiceError("PIN 必须为 6 位数字");
    }
    if (
      params.feature_mask !== undefined &&
      !isValidFeatureMask(params.feature_mask)
    ) {
      throw new ServiceError("feature_mask 无效");
    }

    if (findUserIdByHandle(this.db, params.handle)) {
      throw new ServiceError("该 ID 已存在", 409);
    }

    const pinHash = this.deps.hashPinValue(params.pin);
    this.assertPinHashAvailable(pinHash);

    const userId = this.deps.createId();
    this.db.transaction(() => {
      insertNewUser(this.db, {
        id: userId,
        handle: params.handle!,
        username: (params.username || params.handle!).trim(),
        featureMask: params.feature_mask ?? DEFAULT_FEATURE_MASK,
        pinHashes: [pinHash],
      });
    })();

    return this.get(userId);
  }

  update(id: string, params: UpdateUserParams): User {
    if (!userExists(this.db, id)) {
      throw new ServiceError("干员不存在", 404);
    }

    if (params.handle !== undefined) {
      if (!/^[a-zA-Z0-9_]{1,20}$/.test(params.handle)) {
        throw new ServiceError("ID 只能包含字母、数字、下划线，最多 20 位");
      }
      if (findUserIdByHandleExcept(this.db, params.handle, id)) {
        throw new ServiceError("该 ID 已被占用", 409);
      }
      updateUserHandle(this.db, id, params.handle);
    }

    if (params.username !== undefined) {
      const name = params.username.trim();
      if (!name || name.length > 30) {
        throw new ServiceError("显示名称不能为空，最多 30 个字符");
      }
      updateUserUsername(this.db, id, name);
    }

    if (params.feature_mask !== undefined) {
      if (!isValidFeatureMask(params.feature_mask)) {
        throw new ServiceError("feature_mask 无效");
      }
      updateUserFeatureMask(this.db, id, params.feature_mask);
      // Keep the legacy column synchronized for old database tooling only.
      updateUserRole(
        this.db,
        id,
        (params.feature_mask & 1) !== 0 ? "admin" : "user",
      );
    }

    if (params.pin !== undefined) {
      if (!/^\d{6}$/.test(params.pin)) {
        throw new ServiceError("PIN 必须为 6 位数字");
      }
      const pinHash = this.deps.hashPinValue(params.pin);
      this.assertPinHashAvailable(pinHash, id);
      this.db.transaction(() => {
        replaceUserPins(this.db, id, [pinHash]);
      })();
    }

    const updated = this.get(id);
    this.deps.publishUserEvent(id, {
      kind: "user.profile_changed",
      data: { user: updated },
    });
    return updated;
  }

  async remove(
    id: string,
    selfId: string,
    mode: UserRemovalMode,
  ): Promise<void> {
    if (id === selfId) {
      throw new ServiceError("不能删除自己");
    }
    const user = this.get(id);
    if (mode === "deactivate") {
      const { createGroupService } = await import("./groupsService");
      this.db.transaction(() => {
        createGroupService(this.db).removeUserFromAllGroups(id);
        insertDeletedUser(this.db, user);
        revokeUserCredentials(this.db, id);
      })();
      return;
    }

    // Purge is deliberately explicit: every owning service controls deletion
    // of its own state and side effects before the identity row is removed.
    const [
      { createGroupService },
      { createConversationService },
      { createPostService },
      { createClientService },
      { createUserConfigService },
    ] = await Promise.all([
      import("./groupsService"),
      import("./conversationsService"),
      import("./postsService"),
      import("./clientsService"),
      import("./userConfig"),
    ]);
    createGroupService(this.db).purgeUser(id);
    createConversationService(this.db).purgeUser(id);
    createPostService(this.db).purgeUser(id);
    await createArticleService(this.db).purgeUser(id);
    createWordsService(this.db).purgeUser(id);
    createClientService(this.db).purgeUser(id);
    createUserConfigService(this.db).purgeUser(id);
    deleteUserById(this.db, id);
  }

  ban(id: string, hours: number): void {
    if (!userExists(this.db, id)) {
      throw new ServiceError("干员不存在", 404);
    }
    if (getUserBanStatus(this.db, id).banned) {
      throw new ServiceError("请先解除封禁，再重新配置时长", 409);
    }
    const until = toDbTimestamp(this.deps.now() + hours * 3600_000);
    this.db.transaction(() => {
      updateUserBanUntil(this.db, id, until);
      deleteUserSessions(this.db, id);
    })();
    this.deps.publishUserEvent(id, {
      kind: "user.banned",
      data: { banned_until: until },
    });
  }

  unban(id: string): void {
    updateUserBanUntil(this.db, id, null);
    this.deps.publishUserEvent(id, { kind: "user.unbanned", data: {} });
  }

  mute(id: string, hours: number): void {
    if (!userExists(this.db, id)) {
      throw new ServiceError("干员不存在", 404);
    }
    if (getUserMuteStatus(this.db, id).muted) {
      throw new ServiceError("请先解除禁言，再重新配置时长", 409);
    }
    const until = toDbTimestamp(this.deps.now() + hours * 3600_000);
    updateUserMuted(this.db, id, until);
    this.deps.publishUserEvent(id, {
      kind: "user.muted_changed",
      data: { is_muted: 1, muted_until: until },
    });
  }

  unmute(id: string): void {
    updateUserMuted(this.db, id, null);
    this.deps.publishUserEvent(id, {
      kind: "user.muted_changed",
      data: { is_muted: 0, muted_until: null },
    });
  }

  updateSelfProfile(userId: string, params: UpdateSelfProfileParams): User {
    if (params.handle !== undefined) {
      if (!/^[a-zA-Z0-9_]{1,20}$/.test(params.handle)) {
        throw new ServiceError("ID 只能包含字母、数字、下划线，最多 20 位");
      }
      if (findUserIdByHandleExcept(this.db, params.handle, userId)) {
        throw new ServiceError("该 ID 已被占用", 409);
      }
      updateUserHandle(this.db, userId, params.handle);
    }

    if (params.username !== undefined) {
      const name = params.username.trim();
      if (!name || name.length > 30) {
        throw new ServiceError("显示名称不能为空，最多 30 个字符");
      }
      updateUserUsername(this.db, userId, name);
    }

    const updated = this.get(userId);
    this.deps.publishUserEvent(userId, {
      kind: "user.profile_changed",
      data: { user: updated },
    });
    return updated;
  }

  resetSelfPin(
    userId: string,
    { current_pin, new_pins }: ResetPinParams,
  ): void {
    if (!current_pin || !/^\d{6}$/.test(current_pin)) {
      throw new ServiceError("需要输入当前 PIN 进行验证");
    }
    if (
      !Array.isArray(new_pins) ||
      new_pins.length === 0 ||
      new_pins.length > 2
    ) {
      throw new ServiceError("请提供 1~2 个新 PIN");
    }
    for (const pin of new_pins) {
      if (!/^\d{6}$/.test(pin)) {
        throw new ServiceError("PIN 必须为 6 位数字");
      }
    }
    if (new_pins.length === 2 && new_pins[0] === new_pins[1]) {
      throw new ServiceError("两个新 PIN 不能相同");
    }

    if (!userHasPinHash(this.db, userId, this.deps.hashPinValue(current_pin))) {
      throw new ServiceError("当前 PIN 不正确", 401);
    }

    const nextPinHashes = new_pins.map((pin) => this.deps.hashPinValue(pin));
    for (const pinHash of nextPinHashes) {
      this.assertPinHashAvailable(pinHash, userId);
    }

    this.db.transaction(() => {
      replaceUserPins(this.db, userId, nextPinHashes);
    })();
  }
}

export function createUserService(
  db: BetterSqlite3.Database,
  deps: Partial<UserServiceDeps> = {},
): UserService {
  return new UserService(db, { ...defaultDeps, ...deps });
}
