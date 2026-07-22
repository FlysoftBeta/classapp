import crypto from "crypto";
import type BetterSqlite3 from "better-sqlite3";
import { ServiceError } from "./errors";
import {
  publishRemoteResubscribe,
  publishGroupPost,
  publishDmPost,
} from "./eventBus";
import { publishConversationUpdateForPost } from "@/server/services/conversationsService";
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
import { emptyStoredPostContent } from "@/server/services/postContent";
import {
  pushRecentSticker,
  parseRecentStickers,
} from "@/server/infra/stickerLoader";
import { USER_CONFIG } from "@/shared/userConfig/keys";
import { getUserConfig, setUserConfig } from "./userConfig";
import type { User, Post } from "@/shared/types/api";
import { hasFeature } from "@/shared/features";
import {
  deletePostRow,
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
  updatePostBody,
} from "@/server/data/posts";

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
  return { clause: "AND p.rowid < ?", val: [cursor] };
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
  return { clause: "AND p.rowid > ?", val: [cursor] };
}

export function getPost(db: BetterSqlite3.Database, id: string): Post | null {
  return getPostById(db, id);
}

export interface GetPostsParams {
  before_id?: string;
  after_id?: string;
  before_sequence?: number;
  after_sequence?: number;
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
    limit = 30,
    offset = 0,
  }: GetPostsParams = {},
): Post[] {
  const bc = buildBeforeClause(db, before_id, before_sequence);
  const ac = buildAfterClause(db, after_id, after_sequence);
  return queryFeedPosts(db, userId, {
    beforeClause: bc.clause,
    afterClause: ac.clause,
    args: [...bc.val, ...ac.val],
    order: after_id ? "ASC" : "DESC",
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
  return queryGroupPosts(db, groupId, {
    beforeClause: bc.clause,
    afterClause: ac.clause,
    args: [...bc.val, ...ac.val],
    order: after_id ? "ASC" : "DESC",
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
    limit = 30,
    offset = 0,
  }: GetPostsParams = {},
): Post[] {
  const bc = buildBeforeClause(db, before_id, before_sequence);
  const ac = buildAfterClause(db, after_id, after_sequence);
  return queryDmPosts(db, userId, partnerId, {
    beforeClause: bc.clause,
    afterClause: ac.clause,
    args: [...bc.val, ...ac.val],
    order: after_id ? "ASC" : "DESC",
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
  if (post.group_id) {
    publishGroupPost(post.group_id, { kind: "post.created", data: { post } });
    publishConversationUpdateForPost(db, post);
  } else if (post.dm_to && post.user_id) {
    publishDmPost(post.user_id, post.dm_to, {
      kind: "post.created",
      data: { post },
    });
    publishConversationUpdateForPost(db, post);
    publishRemoteResubscribe(user.id, "dm");
    publishRemoteResubscribe(post.dm_to, "dm");
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
  assertCanCreatePost(db, user, params);

  const id = crypto.randomUUID();
  insertPost(db, {
    id,
    userId: user.id,
    brief: params.brief,
    contentJson: params.content_json,
    groupId: params.group_id,
    dmTo: params.dm_to,
    replyTo: params.reply_to,
  });

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

  if (updated.group_id) {
    publishGroupPost(updated.group_id, {
      kind: "post.updated",
      data: { post: updated },
    });
    publishConversationUpdateForPost(db, updated);
  } else if (updated.dm_to && updated.user_id) {
    publishDmPost(updated.user_id, updated.dm_to, {
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
): void {
  const post = assertCanDeletePost(db, user, postId);
  softDeletePostRow(db, postId, post);
}

function softDeletePostRow(
  db: BetterSqlite3.Database,
  postId: string,
  post: {
    user_id: string | null;
    group_id: string | null;
    dm_to: string | null;
  },
): void {
  markPostDeleted(db, postId, emptyStoredPostContent());

  if (post.group_id) {
    publishGroupPost(post.group_id, {
      kind: "post.deleted",
      data: { id: postId },
    });
    publishConversationUpdateForPost(db, post);
  } else if (post.dm_to && post.user_id) {
    publishDmPost(post.user_id, post.dm_to, {
      kind: "post.deleted",
      data: { id: postId },
    });
    publishConversationUpdateForPost(db, post);
  }
}

export function hardDeletePost(
  db: BetterSqlite3.Database,
  postId: string,
): void {
  const post = getPostAccessRow(db, postId);
  deletePostRow(db, postId);
  if (post?.group_id) {
    publishGroupPost(post.group_id, {
      kind: "post.deleted",
      data: { id: postId },
    });
    publishConversationUpdateForPost(db, post);
  } else if (post?.dm_to && post.user_id) {
    publishDmPost(post.user_id, post.dm_to, {
      kind: "post.deleted",
      data: { id: postId },
    });
    publishConversationUpdateForPost(db, post);
  }
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
  type?: "feed" | "group" | "dm";
  before_id?: string;
  after_id?: string;
  before_sequence?: number;
  after_sequence?: number;
  limit: number;
  offset: number;
  with?: string;
  group?: string;
}

export class PostService {
  constructor(private readonly db: BetterSqlite3.Database) {}

  list(user: User, input: PostListInput): Post[] {
    if (input.type === "dm" && input.with) {
      return getDmPosts(this.db, user.id, input.with, input);
    }
    if (input.type === "group" && input.group) {
      return getGroupPosts(
        this.db,
        user.id,
        input.group,
        input,
        hasFeature(user, "admin"),
      );
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

  softDelete(user: User, postId: string): void {
    softDeletePost(this.db, postId, user);
  }

  adminList(input: ListAdminPostsParams = {}): {
    posts: Post[];
    total: number;
  } {
    return listAllPosts(this.db, input);
  }

  adminDelete(postId: string): void {
    hardDeletePost(this.db, postId);
  }
}

export function createPostService(db: BetterSqlite3.Database): PostService {
  return new PostService(db);
}
