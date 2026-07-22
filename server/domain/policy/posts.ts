import type { Database } from "better-sqlite3";
import { ServiceError } from "@/server/services/errors";
import type { User } from "@/shared/types/api";
import {
  assertCanPostToGroup,
  assertGroupMember,
  assertUserNotMuted,
} from "./membership";
import type { NormalizedCreatePost } from "@/server/validation/posts";
import {
  parseStoredPostContent,
  isStoredEditable,
} from "@/server/services/postContent";
import {
  findPostAccessRow,
  usersShareGroup,
  type PostAccessRow,
} from "@/server/data/posts";
import { hasFeature } from "@/shared/features";

export function assertCanAccessPost(
  db: Database,
  user: User,
  postId: string,
): PostAccessRow {
  const post = findPostAccessRow(db, postId);
  if (!post) throw new ServiceError("帖子不存在", 404);

  if (hasFeature(user, "admin")) return post;

  if (post.group_id) {
    assertGroupMember(db, user.id, post.group_id);
  } else if (post.dm_to && post.user_id) {
    if (post.user_id !== user.id && post.dm_to !== user.id) {
      throw new ServiceError("无权访问", 403);
    }
  } else {
    throw new ServiceError("无权访问", 403);
  }
  return post;
}

function assertSharedGroup(
  db: Database,
  userId: string,
  partnerId: string,
): void {
  if (!usersShareGroup(db, userId, partnerId)) {
    throw new ServiceError("你与该干员没有共同群组，无法私信", 403);
  }
}

function assertReplyContext(
  db: Database,
  user: User,
  params: NormalizedCreatePost,
): void {
  if (!params.reply_to) return;

  const reply = findPostAccessRow(db, params.reply_to);

  if (!reply) throw new ServiceError("被引用的帖子不存在", 404);
  if (reply.is_deleted) throw new ServiceError("被引用的帖子已删除", 400);

  if (params.group_id) {
    if (reply.group_id !== params.group_id || reply.dm_to) {
      throw new ServiceError("引用帖与目标群组不匹配", 400);
    }
  } else if (params.dm_to) {
    const inDm =
      (reply.user_id === user.id && reply.dm_to === params.dm_to) ||
      (reply.user_id === params.dm_to && reply.dm_to === user.id);
    if (!inDm || reply.group_id) {
      throw new ServiceError("引用帖与私信会话不匹配", 400);
    }
  }

  assertCanAccessPost(db, user, params.reply_to);
}

/** Full create-post policy — route and service both call this. */
export function assertCanCreatePost(
  db: Database,
  user: User,
  params: NormalizedCreatePost,
): void {
  assertUserNotMuted(user);

  if (params.group_id) {
    assertCanPostToGroup(db, user, params.group_id);
  } else if (params.dm_to) {
    assertSharedGroup(db, user.id, params.dm_to);
  }

  assertReplyContext(db, user, params);
}

export function assertCanEditPost(
  db: Database,
  user: User,
  postId: string,
): PostAccessRow {
  const post = assertCanAccessPost(db, user, postId);
  const stored = parseStoredPostContent(post.content_json);
  if (!isStoredEditable(stored)) {
    throw new ServiceError("此类型消息不能编辑", 403);
  }
  if (post.is_deleted) throw new ServiceError("帖子已删除", 400);
  if (post.user_id !== user.id) throw new ServiceError("无权修改此帖", 403);
  if (post.group_id) assertCanPostToGroup(db, user, post.group_id);
  assertUserNotMuted(user);
  return post;
}

export function assertCanDeletePost(
  db: Database,
  user: User,
  postId: string,
): PostAccessRow {
  const post = assertCanAccessPost(db, user, postId);
  if (post.user_id !== user.id && !hasFeature(user, "admin")) {
    throw new ServiceError("无权删除此帖", 403);
  }
  return post;
}
