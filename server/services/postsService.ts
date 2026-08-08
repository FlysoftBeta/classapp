import crypto from "crypto";
import type BetterSqlite3 from "better-sqlite3";
import { ServiceError } from "./errors";
import {
  publishRemoteResubscribe,
  publishGroupPost,
  publishDmPost,
} from "./eventBus";
import {
  publishConversationUpdate,
  publishConversationUpdateForPost,
} from "@/server/services/conversationsService";
import {
  assertCanAccessPost,
  assertCanCreatePost,
  assertCanDeletePost,
  assertCanEditPost,
} from "@/server/domain/policy/posts";
import {
  normalizeCreatePost,
  normalizeUpdatePost,
  type CreatePostInput,
} from "@/server/validation/posts";
import {
  pushRecentSticker,
  parseRecentStickers,
} from "@/server/infra/stickerLoader";
import { USER_CONFIG } from "@/shared/userConfig/keys";
import { getUserConfig, setUserConfig } from "./userConfig";
import type { User, Post } from "@/shared/types/api";
import { hasFeature } from "@/shared/features";
import {
  findSharedVisibleGroup,
  getPostAccessRow,
  getPostById,
  getPostRowid,
  groupMembershipExists,
  insertPost,
  listAdminPosts,
  markPostDeleted,
  parsePostStoredContent,
  queryDmPosts,
  queryFeedPosts,
  queryGroupPosts,
  purgePostsByUser,
  updatePostBody,
} from "@/server/data/posts";
import {
  findDmConversation,
  insertDmConversation,
  listConversationParticipantIds,
} from "@/server/data/conversations";
import { parseConvId } from "@/shared/conversations/id";
import { userExists } from "@/server/data/groups";

const POST_CONTENT_MAX = 5_000_000;

function recordRecentSticker(
  db: BetterSqlite3.Database,
  userId: string,
  contentJson: string,
): void {
  const stored = parsePostStoredContent(contentJson);
  if (stored?.type !== "sticker") return;
  const existing = parseRecentStickers(
    getUserConfig(db, userId, USER_CONFIG.RECENT_STICKERS),
  );
  const next = pushRecentSticker(existing, {
    pack: stored.sticker_pack,
    id: stored.sticker_id,
  });
  setUserConfig(db, userId, USER_CONFIG.RECENT_STICKERS, JSON.stringify(next));
}

function buildBeforeClause(
  db: BetterSqlite3.Database,
  beforeId = "",
  beforeSequence?: number,
): { clause: string; val: number[] } {
  if (!beforeId) return { clause: "", val: [] };
  const rowid = getPostRowid(db, beforeId);
  const cursor = rowid ?? beforeSequence;
  if (cursor == null) throw new ServiceError("游标帖子不存在", 400);
  return { clause: "AND p.sequence < ?", val: [cursor] };
}

function buildAfterClause(
  db: BetterSqlite3.Database,
  afterId = "",
  afterSequence?: number,
): { clause: string; val: number[] } {
  if (!afterId) return { clause: "", val: [] };
  const rowid = getPostRowid(db, afterId);
  const cursor = rowid ?? afterSequence;
  if (cursor == null) throw new ServiceError("游标帖子不存在", 400);
  return { clause: "AND p.sequence > ?", val: [cursor] };
}

export function getPost(db: BetterSqlite3.Database, id: string): Post | null {
  return getPostById(db, id);
}

export interface GetPostsParams {
  before_id?: string;
  after_id?: string;
  before_sequence?: number;
  after_sequence?: number;
  changed_after_revision?: number;
  changed_through_revision?: number;
  limit?: number;
  offset?: number;
}

export function getFeedPosts(
  db: BetterSqlite3.Database,
  userId: string,
  {
    before_id = "",
    after_id = "",
    before_sequence,
    after_sequence,
    changed_after_revision,
    changed_through_revision,
    limit = 30,
    offset = 0,
  }: GetPostsParams = {},
): Post[] {
  const bc = buildBeforeClause(db, before_id, before_sequence);
  const ac = buildAfterClause(db, after_id, after_sequence);
  const revisionClause =
    changed_after_revision == null ? "" : "AND p.revision > ?";
  const revisionUpperClause =
    changed_through_revision == null ? "" : "AND p.revision <= ?";
  return queryFeedPosts(db, userId, {
    beforeClause: bc.clause,
    afterClause: `${ac.clause} ${revisionClause} ${revisionUpperClause}`,
    args: [
      ...bc.val,
      ...ac.val,
      ...(changed_after_revision == null ? [] : [changed_after_revision]),
      ...(changed_through_revision == null ? [] : [changed_through_revision]),
    ],
    order: after_id ? "ASC" : "DESC",
    revisionOrder: changed_after_revision != null,
    limit,
    offset,
  });
}

export function getGroupPosts(
  db: BetterSqlite3.Database,
  userId: string,
  groupId: string,
  {
    before_id = "",
    after_id = "",
    before_sequence,
    after_sequence,
    changed_after_revision,
    changed_through_revision,
    limit = 30,
    offset = 0,
  }: GetPostsParams = {},
  isAdmin = false,
): Post[] {
  if (!groupMembershipExists(db, userId, groupId) && !isAdmin) {
    throw new ServiceError("你不在该群组中", 403);
  }

  const bc = buildBeforeClause(db, before_id, before_sequence);
  const ac = buildAfterClause(db, after_id, after_sequence);
  const revisionClause =
    changed_after_revision == null ? "" : "AND p.revision > ?";
  const revisionUpperClause =
    changed_through_revision == null ? "" : "AND p.revision <= ?";
  return queryGroupPosts(db, `group:${groupId}`, {
    beforeClause: bc.clause,
    afterClause: `${ac.clause} ${revisionClause} ${revisionUpperClause}`,
    args: [
      ...bc.val,
      ...ac.val,
      ...(changed_after_revision == null ? [] : [changed_after_revision]),
      ...(changed_through_revision == null ? [] : [changed_through_revision]),
    ],
    order: after_id ? "ASC" : "DESC",
    revisionOrder: changed_after_revision != null,
    limit,
    offset,
  });
}

export function getDmPosts(
  db: BetterSqlite3.Database,
  userId: string,
  partnerId: string,
  {
    before_id = "",
    after_id = "",
    before_sequence,
    after_sequence,
    changed_after_revision,
    changed_through_revision,
    limit = 30,
    offset = 0,
  }: GetPostsParams = {},
): Post[] {
  const bc = buildBeforeClause(db, before_id, before_sequence);
  const ac = buildAfterClause(db, after_id, after_sequence);
  const revisionClause =
    changed_after_revision == null ? "" : "AND p.revision > ?";
  const revisionUpperClause =
    changed_through_revision == null ? "" : "AND p.revision <= ?";
  return queryDmPosts(db, `dm:${[userId, partnerId].sort().join(":")}`, {
    beforeClause: bc.clause,
    afterClause: `${ac.clause} ${revisionClause} ${revisionUpperClause}`,
    args: [
      ...bc.val,
      ...ac.val,
      ...(changed_after_revision == null ? [] : [changed_after_revision]),
      ...(changed_through_revision == null ? [] : [changed_through_revision]),
    ],
    order: after_id ? "ASC" : "DESC",
    revisionOrder: changed_after_revision != null,
    limit,
    offset,
  });
}

export interface CreatePostOptions {
  /** Defer event publication until the caller commits a surrounding transaction. */
  deferNotify?: boolean;
}

export function notifyPostCreated(
  db: BetterSqlite3.Database,
  user: User,
  post: Post,
): void {
  const parsed = parseConvId(post.conv_id);
  if (parsed?.type === "group") {
    publishGroupPost(parsed.groupId, { kind: "post.created", data: { post } });
    publishConversationUpdateForPost(db, post);
  } else if (parsed?.type === "dm") {
    publishDmPost(parsed.peerA, parsed.peerB, {
      kind: "post.created",
      data: { post },
    });
    publishConversationUpdateForPost(db, post);
    publishRemoteResubscribe(parsed.peerA, "dm");
    publishRemoteResubscribe(parsed.peerB, "dm");
  }
}

export function createPost(
  db: BetterSqlite3.Database,
  user: User,
  raw: CreatePostInput,
  opts?: CreatePostOptions,
): Post {
  const params = normalizeCreatePost(raw);
  if (params.brief.length > POST_CONTENT_MAX) {
    throw new ServiceError("内容过长（最多 500 万字符）");
  }
  const id = crypto.randomUUID();
  db.transaction(() => {
    const parsed = parseConvId(params.conv_id);
    if (!parsed) throw new ServiceError("会话 ID 无效", 400);
    if (parsed.type === "dm") {
      if (parsed.peerA !== user.id && parsed.peerB !== user.id) {
        throw new ServiceError("无权建立该私信", 403);
      }
      const peerId = parsed.peerA === user.id ? parsed.peerB : parsed.peerA;
      if (!userExists(db, peerId)) throw new ServiceError("干员不存在", 404);
      if (!findDmConversation(db, parsed.peerA, parsed.peerB)) {
        const proofGroupId = findSharedVisibleGroup(db, user.id, peerId);
        if (!proofGroupId) {
          throw new ServiceError(
            "你与该干员没有互相可见的共同群组，无法私信",
            403,
          );
        }
        insertDmConversation(db, user.id, peerId, proofGroupId);
      }
    }
    assertCanCreatePost(db, user, params);
    insertPost(db, {
      id,
      userId: user.id,
      convId: params.conv_id,
      brief: params.brief,
      contentJson: params.content_json,
      replyTo: params.reply_to,
    });
  })();

  recordRecentSticker(db, user.id, params.content_json);

  const post = getPostById(db, id);
  if (!post) {
    throw new ServiceError("帖子不存在", 404);
  }

  if (!opts?.deferNotify) {
    notifyPostCreated(db, user, post);
  }

  return post;
}

export function updatePost(
  db: BetterSqlite3.Database,
  postId: string,
  user: User,
  text: string,
): Post {
  assertCanEditPost(db, user, postId);
  const params = normalizeUpdatePost(text);
  if (params.brief.length > POST_CONTENT_MAX) {
    throw new ServiceError("内容过长（最多 500 万字符）");
  }

  updatePostBody(db, postId, params.brief, params.content_json);

  const updated = getPostById(db, postId);
  if (!updated) {
    throw new ServiceError("帖子不存在", 404);
  }

  const parsed = parseConvId(updated.conv_id);
  if (parsed?.type === "group") {
    publishGroupPost(parsed.groupId, {
      kind: "post.updated",
      data: { post: updated },
    });
    publishConversationUpdateForPost(db, updated);
  } else if (parsed?.type === "dm") {
    publishDmPost(parsed.peerA, parsed.peerB, {
      kind: "post.updated",
      data: { post: updated },
    });
    publishConversationUpdateForPost(db, updated);
  }
  return updated;
}

export function softDeletePost(
  db: BetterSqlite3.Database,
  postId: string,
  user: User,
): Post {
  const post = assertCanDeletePost(db, user, postId);
  return softDeletePostRow(db, postId, post);
}

function softDeletePostRow(
  db: BetterSqlite3.Database,
  postId: string,
  post: {
    user_id: string | null;
    conv_id: string;
  },
): Post {
  markPostDeleted(db, postId);
  const tombstone = getPostById(db, postId);
  if (!tombstone) throw new ServiceError("帖子不存在", 404);

  const parsed = parseConvId(post.conv_id);
  if (parsed?.type === "group") {
    publishGroupPost(parsed.groupId, {
      kind: "post.deleted",
      data: { post: tombstone },
    });
    publishConversationUpdateForPost(db, tombstone);
  } else if (parsed?.type === "dm") {
    publishDmPost(parsed.peerA, parsed.peerB, {
      kind: "post.deleted",
      data: { post: tombstone },
    });
    publishConversationUpdateForPost(db, tombstone);
  }
  return tombstone;
}

export function adminDeletePost(
  db: BetterSqlite3.Database,
  postId: string,
): void {
  const post = getPostAccessRow(db, postId);
  if (post) softDeletePostRow(db, postId, post);
}

export interface ListAdminPostsParams {
  q?: string;
  userId?: string;
  offset?: number;
}

export function listAllPosts(
  db: BetterSqlite3.Database,
  { q = "", userId = "", offset = 0 }: ListAdminPostsParams = {},
): { posts: Post[]; total: number } {
  return listAdminPosts(db, { q, userId, offset });
}

export interface PostListInput {
  type?: "feed" | "conversation";
  conv_id?: string;
  before_id?: string;
  after_id?: string;
  before_sequence?: number;
  after_sequence?: number;
  changed_after_revision?: number;
  changed_through_revision?: number;
  limit: number;
  offset: number;
}

export class PostService {
  constructor(private readonly db: BetterSqlite3.Database) {}

  list(user: User, input: PostListInput): Post[] {
    if (
      input.changed_through_revision != null &&
      input.changed_after_revision == null
    ) {
      throw new ServiceError("revision 上界缺少下界", 400);
    }
    if (
      input.changed_after_revision != null &&
      input.changed_through_revision != null &&
      input.changed_through_revision < input.changed_after_revision
    ) {
      throw new ServiceError("revision 范围无效", 400);
    }
    if (input.type === "conversation") {
      if (!input.conv_id) throw new ServiceError("缺少会话 ID", 400);
      const parsed = parseConvId(input.conv_id);
      if (!parsed) throw new ServiceError("会话 ID 无效", 400);
      if (parsed.type === "group") {
        return getGroupPosts(
          this.db,
          user.id,
          parsed.groupId,
          input,
          hasFeature(user, "admin"),
        );
      }
      const peerId = parsed.peerA === user.id ? parsed.peerB : parsed.peerA;
      if (parsed.peerA !== user.id && parsed.peerB !== user.id) {
        throw new ServiceError("无权访问", 403);
      }
      if (!findDmConversation(this.db, parsed.peerA, parsed.peerB)) {
        throw new ServiceError("对话不存在", 404);
      }
      return getDmPosts(this.db, user.id, peerId, input);
    }
    if (input.changed_after_revision != null) {
      throw new ServiceError("feed 不支持对话 revision 补拉", 400);
    }
    return getFeedPosts(this.db, user.id, input);
  }

  get(user: User, postId: string): Post {
    assertCanAccessPost(this.db, user, postId);
    const post = getPost(this.db, postId);
    if (!post) {
      throw new ServiceError("帖子不存在", 404);
    }
    return post;
  }

  create(user: User, raw: CreatePostInput, opts?: CreatePostOptions): Post {
    return createPost(this.db, user, raw, opts);
  }

  update(user: User, postId: string, text: string): Post {
    return updatePost(this.db, postId, user, text);
  }

  softDelete(user: User, postId: string): Post {
    return softDeletePost(this.db, postId, user);
  }

  adminList(input: ListAdminPostsParams = {}): {
    posts: Post[];
    total: number;
  } {
    return listAllPosts(this.db, input);
  }

  adminDelete(postId: string): void {
    adminDeletePost(this.db, postId);
  }

  purgeUser(userId: string): void {
    const affected = purgePostsByUser(this.db, userId);
    for (const post of affected.posts) {
      const tombstone = getPostById(this.db, post.id);
      if (!tombstone) continue;
      const parsed = parseConvId(post.conv_id);
      if (parsed?.type === "group") {
        publishGroupPost(parsed.groupId, {
          kind: "post.deleted",
          data: { post: tombstone },
        });
      } else if (parsed?.type === "dm") {
        publishDmPost(parsed.peerA, parsed.peerB, {
          kind: "post.deleted",
          data: { post: tombstone },
        });
      }
    }
    for (const convId of affected.convIds) {
      for (const participantId of listConversationParticipantIds(
        this.db,
        convId,
      )) {
        const parsed = parseConvId(convId);
        if (parsed?.type === "group") {
          publishConversationUpdate(this.db, participantId, {
            type: "group",
            id: parsed.groupId,
          });
        } else if (parsed?.type === "dm") {
          const peerId =
            parsed.peerA === participantId ? parsed.peerB : parsed.peerA;
          publishConversationUpdate(this.db, participantId, {
            type: "dm",
            id: peerId,
          });
        }
      }
    }
  }
}

export function createPostService(db: BetterSqlite3.Database): PostService {
  return new PostService(db);
}
