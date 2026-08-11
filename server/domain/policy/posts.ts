import type { Database } from "better-sqlite3";
import { PublicError } from "@/server/services/incidentService";
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
import { findPostAccessRow, type PostAccessRow } from "@/server/data/posts";
import { hasFeature } from "@/shared/features";
import { parseConvId } from "@/shared/conversations/id";
import { conversationExists } from "@/server/data/conversations";

function assertConversationAccess(
  db: Database,
  user: User,
  convId: string,
): void {
  const parsed = parseConvId(convId);
  if (!parsed || !conversationExists(db, convId)) {
    throw new PublicError("对话不存在");
  }
  if (hasFeature(user, "admin")) return;
  if (parsed.type === "group") {
    assertGroupMember(db, user.id, parsed.groupId);
    return;
  }
  if (parsed.peerA !== user.id && parsed.peerB !== user.id) {
    throw new PublicError("无权访问");
  }
}

export function assertCanAccessPost(
  db: Database,
  user: User,
  postId: string,
): PostAccessRow {
  const post = findPostAccessRow(db, postId);
  if (!post) throw new PublicError("帖子不存在");
  assertConversationAccess(db, user, post.conv_id);
  return post;
}

function assertReplyContext(
  db: Database,
  user: User,
  params: NormalizedCreatePost,
): void {
  if (!params.reply_to) return;
  const reply = findPostAccessRow(db, params.reply_to);
  if (!reply) throw new PublicError("被引用的帖子不存在");
  if (reply.deleted_at) throw new PublicError("被引用的帖子已删除");
  if (reply.conv_id !== params.conv_id)
    throw new PublicError("引用帖与目标会话不匹配");
  assertCanAccessPost(db, user, params.reply_to);
}

export function assertCanCreatePost(
  db: Database,
  user: User,
  params: NormalizedCreatePost,
): void {
  assertUserNotMuted(user);
  const parsed = parseConvId(params.conv_id);
  if (!parsed) throw new PublicError("会话 ID 无效");
  if (parsed.type === "group") assertCanPostToGroup(db, user, parsed.groupId);
  else assertConversationAccess(db, user, params.conv_id);
  assertReplyContext(db, user, params);
}

export function assertCanEditPost(
  db: Database,
  user: User,
  postId: string,
): PostAccessRow {
  const post = assertCanAccessPost(db, user, postId);
  if (!isStoredEditable(parseStoredPostContent(post.content_json))) {
    throw new PublicError("此类型消息不能编辑");
  }
  if (post.deleted_at) throw new PublicError("帖子已删除");
  if (post.user_id !== user.id) throw new PublicError("无权修改此帖");
  const parsed = parseConvId(post.conv_id);
  if (parsed?.type === "group") assertCanPostToGroup(db, user, parsed.groupId);
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
    throw new PublicError("无权删除此帖");
  }
  return post;
}
