import type { Database } from "better-sqlite3";
import { ServiceError } from "@/server/services/errors";
import type { User } from "@/shared/types/api";
import { assertUserNotMuted } from "./membership";
import { findArticleAccessRow } from "@/server/data/articles";
import { hasFeature } from "@/shared/features";

export function assertCanCreateArticle(_db: Database, user: User): void {
  assertUserNotMuted(user);
}

export function assertCanMutateArticle(
  db: Database,
  user: User,
  articleId: string,
): { user_id: string | null } {
  const row = findArticleAccessRow(db, articleId);
  if (!row) throw new ServiceError("文章不存在", 404);
  if (row.user_id !== user.id && !hasFeature(user, "admin")) {
    throw new ServiceError("无权访问", 403);
  }
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
