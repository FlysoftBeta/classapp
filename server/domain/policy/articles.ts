import type { Database } from "better-sqlite3";
import { ServiceError } from "@/server/services/errors";
import type { User } from "@/shared/types/api";
import {
  assertCanPostToGroup,
  assertGroupMember,
  assertUserNotMuted,
} from "./membership";
import { findArticleAccessRow } from "@/server/data/articles";
import { hasFeature } from "@/shared/features";

export function assertCanCreateArticle(
  db: Database,
  user: User,
  groupId: string,
): void {
  assertUserNotMuted(user);
  assertCanPostToGroup(db, user, groupId);
}

export function assertCanMutateArticle(
  db: Database,
  user: User,
  articleId: string,
): { user_id: string | null; group_id: string } {
  const row = findArticleAccessRow(db, articleId);
  if (!row) throw new ServiceError("文章不存在", 404);
  assertGroupMember(db, user.id, row.group_id);
  return row;
}

export const assertCanAccessArticle = assertCanMutateArticle;

export function assertCanDeleteArticle(
  db: Database,
  user: User,
  articleId: string,
): void {
  const article = assertCanMutateArticle(db, user, articleId);
  if (article.user_id !== user.id && !hasFeature(user, "admin")) {
    throw new ServiceError("无权删除此文章", 403);
  }
}
