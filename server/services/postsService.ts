import crypto from "crypto";
import type BetterSqlite3 from "better-sqlite3";
import { PublicError } from "@/server/services/incidentService";
import {
  publishRemoteResubscribe,
  publishGroupPost,
  publishDmPost,
} from "@/server/runtime/eventBus";
import {
  publishConversationUpdate,
  publishConversationUpdateForPost,
} from "@/server/services/conversationsService";
import {
  normalizeCreatePost,
  normalizeUpdatePost,
  type CreatePostInput,
  type NormalizedCreatePost,
} from "@/server/validation/posts";
import {
  pushRecentSticker,
  parseRecentStickers,
} from "@/server/infra/stickerLoader";
import { USER_CONFIG } from "@/shared/userConfig/keys";
import { getUserConfig, setUserConfig } from "./userConfig";
import type { PostEntity } from "@/shared/types/api";
import {
  findSharedVisibleGroup,
  getPostAccessRow,
  getPostById,
  getPostRowid,
  groupMembershipExists,
  insertPost,
  listAdminPosts,
  markPostDeleted,
  postUserMetadata,
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
  if (cursor == null) throw new PublicError("游标帖子不存在");
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
  if (cursor == null) throw new PublicError("游标帖子不存在");
  return { clause: "AND p.sequence > ?", val: [cursor] };
}

export function getPost(
  db: BetterSqlite3.Database,
  id: string,
): PostEntity | null {
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
): PostEntity[] {
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
): PostEntity[] {
  if (!groupMembershipExists(db, userId, groupId) && !isAdmin) {
    throw new PublicError("你不在该群组中");
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
): PostEntity[] {
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
  /** Direct-message target already authorized by the ActorFacade. */
  authorizedDirectPeerId?: string;
}

function ensureDirectConversation(
  db: BetterSqlite3.Database,
  userId: string,
  peerId: string,
): void {
  if (!userExists(db, peerId)) throw new PublicError("干员不存在");
  if (findDmConversation(db, userId, peerId)) return;
  const proofGroupId = findSharedVisibleGroup(db, userId, peerId);
  if (!proofGroupId) {
    throw new PublicError("你与该干员没有互相可见的共同群组，无法私信");
  }
  insertDmConversation(db, userId, peerId, proofGroupId);
}

export function notifyPostCreated(
  db: BetterSqlite3.Database,
  post: PostEntity,
): void {
  const users = postUserMetadata(db, [post]);
  const parsed = parseConvId(post.conv_id);
  if (parsed?.type === "group") {
    publishGroupPost(parsed.groupId, {
      kind: "post.created",
      data: { post, users },
    });
    publishConversationUpdateForPost(db, post);
  } else if (parsed?.type === "dm") {
    publishDmPost(parsed.peerA, parsed.peerB, {
      kind: "post.created",
      data: { post, users },
    });
    publishConversationUpdateForPost(db, post);
    publishRemoteResubscribe(parsed.peerA, "dm");
    publishRemoteResubscribe(parsed.peerB, "dm");
  }
}

export function createPost(
  db: BetterSqlite3.Database,
  userId: string,
  params: NormalizedCreatePost,
  opts?: CreatePostOptions,
): PostEntity {
  if (params.brief.length > POST_CONTENT_MAX) {
    throw new PublicError("内容过长（最多 500 万字符）");
  }
  const id = crypto.randomUUID();
  db.transaction(() => {
    if (opts?.authorizedDirectPeerId) {
      ensureDirectConversation(db, userId, opts.authorizedDirectPeerId);
    }
    insertPost(db, {
      id,
      userId,
      convId: params.conv_id,
      brief: params.brief,
      contentJson: params.content_json,
      replyTo: params.reply_to,
    });
  })();

  recordRecentSticker(db, userId, params.content_json);

  const post = getPostById(db, id);
  if (!post) {
    throw new PublicError("帖子不存在");
  }

  if (!opts?.deferNotify) {
    notifyPostCreated(db, post);
  }

  return post;
}

export function updatePost(
  db: BetterSqlite3.Database,
  postId: string,
  text: string,
): PostEntity {
  const params = normalizeUpdatePost(text);
  if (params.brief.length > POST_CONTENT_MAX) {
    throw new PublicError("内容过长（最多 500 万字符）");
  }

  updatePostBody(db, postId, params.brief, params.content_json);

  const updated = getPostById(db, postId);
  if (!updated) {
    throw new PublicError("帖子不存在");
  }

  const parsed = parseConvId(updated.conv_id);
  const users = postUserMetadata(db, [updated]);
  if (parsed?.type === "group") {
    publishGroupPost(parsed.groupId, {
      kind: "post.updated",
      data: { post: updated, users },
    });
    publishConversationUpdateForPost(db, updated);
  } else if (parsed?.type === "dm") {
    publishDmPost(parsed.peerA, parsed.peerB, {
      kind: "post.updated",
      data: { post: updated, users },
    });
    publishConversationUpdateForPost(db, updated);
  }
  return updated;
}

export function softDeletePost(
  db: BetterSqlite3.Database,
  postId: string,
): PostEntity {
  const post = getPostAccessRow(db, postId);
  if (!post) throw new PublicError("帖子不存在");
  return softDeletePostRow(db, postId, post);
}

function softDeletePostRow(
  db: BetterSqlite3.Database,
  postId: string,
  post: {
    user_id: string | null;
    conv_id: string;
  },
): PostEntity {
  markPostDeleted(db, postId);
  const tombstone = getPostById(db, postId);
  if (!tombstone) throw new PublicError("帖子不存在");

  const parsed = parseConvId(post.conv_id);
  const users = postUserMetadata(db, [tombstone]);
  if (parsed?.type === "group") {
    publishGroupPost(parsed.groupId, {
      kind: "post.deleted",
      data: { post: tombstone, users },
    });
    publishConversationUpdateForPost(db, tombstone);
  } else if (parsed?.type === "dm") {
    publishDmPost(parsed.peerA, parsed.peerB, {
      kind: "post.deleted",
      data: { post: tombstone, users },
    });
    publishConversationUpdateForPost(db, tombstone);
  }
  return tombstone;
}

export function adminDeletePost(
  db: BetterSqlite3.Database,
  postId: string,
): PostEntity | null {
  const post = getPostAccessRow(db, postId);
  return post ? softDeletePostRow(db, postId, post) : null;
}

export interface ListAdminPostsParams {
  q?: string;
  userId?: string;
  offset?: number;
}

export function listAllPosts(
  db: BetterSqlite3.Database,
  { q = "", userId = "", offset = 0 }: ListAdminPostsParams = {},
): { posts: PostEntity[]; total: number } {
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

  list(userId: string, input: PostListInput) {
    if (
      input.changed_through_revision != null &&
      input.changed_after_revision == null
    ) {
      throw new PublicError("revision 上界缺少下界");
    }
    if (
      input.changed_after_revision != null &&
      input.changed_through_revision != null &&
      input.changed_through_revision < input.changed_after_revision
    ) {
      throw new PublicError("revision 范围无效");
    }
    if (input.type === "conversation") {
      if (!input.conv_id) throw new PublicError("缺少会话 ID");
      const parsed = parseConvId(input.conv_id);
      if (!parsed) throw new PublicError("会话 ID 无效");
      if (parsed.type === "group") {
        const posts = getGroupPosts(
          this.db,
          userId,
          parsed.groupId,
          input,
          true,
        );
        return { posts, users: postUserMetadata(this.db, posts) };
      }
      const peerId = parsed.peerA === userId ? parsed.peerB : parsed.peerA;
      const posts = getDmPosts(this.db, userId, peerId, input);
      return { posts, users: postUserMetadata(this.db, posts) };
    }
    if (input.changed_after_revision != null) {
      throw new PublicError("feed 不支持对话 revision 补拉");
    }
    const posts = getFeedPosts(this.db, userId, input);
    return { posts, users: postUserMetadata(this.db, posts) };
  }

  get(postId: string) {
    const post = getPost(this.db, postId);
    if (!post) {
      throw new PublicError("帖子不存在");
    }
    return { post, users: postUserMetadata(this.db, [post]) };
  }

  normalizeCreate(raw: CreatePostInput): NormalizedCreatePost {
    return normalizeCreatePost(raw);
  }

  create(
    userId: string,
    input: NormalizedCreatePost,
    opts?: CreatePostOptions,
  ) {
    const post = createPost(this.db, userId, input, opts);
    return { post, users: postUserMetadata(this.db, [post]) };
  }

  update(postId: string, text: string) {
    const post = updatePost(this.db, postId, text);
    return { post, users: postUserMetadata(this.db, [post]) };
  }

  softDelete(postId: string) {
    const post = softDeletePost(this.db, postId);
    return { post, users: postUserMetadata(this.db, [post]) };
  }

  adminList(input: ListAdminPostsParams = {}): {
    posts: PostEntity[];
    total: number;
  } {
    return listAllPosts(this.db, input);
  }

  adminDelete(postId: string): void {
    adminDeletePost(this.db, postId);
  }

  forceDelete(postId: string) {
    const post = adminDeletePost(this.db, postId);
    if (!post) throw new PublicError("帖子不存在");
    return { post, users: postUserMetadata(this.db, [post]) };
  }

  access(postId: string) {
    const post = getPostAccessRow(this.db, postId);
    if (!post) throw new PublicError("帖子不存在");
    return post;
  }

  directConversationExists(peerA: string, peerB: string): boolean {
    return findDmConversation(this.db, peerA, peerB) !== null;
  }

  purgeUser(userId: string): void {
    const affected = purgePostsByUser(this.db, userId);
    for (const post of affected.posts) {
      const tombstone = getPostById(this.db, post.id);
      if (!tombstone) continue;
      const parsed = parseConvId(post.conv_id);
      const users = postUserMetadata(this.db, [tombstone]);
      if (parsed?.type === "group") {
        publishGroupPost(parsed.groupId, {
          kind: "post.deleted",
          data: { post: tombstone, users },
        });
      } else if (parsed?.type === "dm") {
        publishDmPost(parsed.peerA, parsed.peerB, {
          kind: "post.deleted",
          data: { post: tombstone, users },
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
