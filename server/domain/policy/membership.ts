import type { Database } from "better-sqlite3";
import { findGroupAdminOnly, isGroupMember } from "@/server/data/groups";
import { ServiceError } from "@/server/services/errors";
import type { User } from "@/shared/types/api";
import { hasFeature } from "@/shared/features";

export function assertGroupMember(
  db: Database,
  userId: string,
  groupId: string,
): void {
  if (!isGroupMember(db, userId, groupId)) {
    throw new ServiceError("你不在该群组中", 403);
  }
}

/** Membership + admin_only posting restriction. */
export function assertCanPostToGroup(
  db: Database,
  user: User,
  groupId: string,
): void {
  assertGroupMember(db, user.id, groupId);
  if (
    !hasFeature(user, "admin") &&
    findGroupAdminOnly(db, groupId)?.admin_only === 1
  ) {
    throw new ServiceError("该群组仅管理员可以发言", 403);
  }
}

export function assertUserNotMuted(user: User): void {
  if (user.is_muted) throw new ServiceError("你已被禁言", 403);
}
