import type { Database } from "better-sqlite3";
import type { PostEntity, UserMetadata } from "@/shared/types/api";
import { getStickerEntry } from "@/server/infra/stickerLoader";
import {
  loadStoredContent,
  parseStoredPostContent,
  resolveStoredText,
} from "@/server/services/postContent";
import { POST_PREVIEW_LENGTH } from "@/shared/validation/posts";

export interface PostRow {
  id: string;
  sequence: number;
  user_id: string | null;
  conv_id: string;
  revision: number;
  brief: string;
  content_json: string;
  reply_to: string | null;
  deleted_at: string | null;
  edited_at: string | null;
  created_at: string;
  reply_user_id: string | null;
  reply_brief?: string | null;
}

export interface PostAccessRow {
  id: string;
  user_id: string | null;
  conv_id: string;
  content_json: string;
  deleted_at: string | null;
}

export const POST_WITH_REPLY_SQL = `
  SELECT p.id, p.sequence, p.author_id AS user_id, p.conv_id, p.revision, p.brief,
    p.content_json, p.reply_to, p.deleted_at, p.edited_at, p.created_at,
    r.author_id AS reply_user_id, r.brief AS reply_brief
  FROM posts p
  LEFT JOIN posts r ON p.reply_to = r.id
`;

export function hydratePost(row: PostRow): PostEntity {
  const stored = loadStoredContent(row);
  const base = {
    id: row.id,
    sequence: row.sequence,
    user_id: row.user_id,
    conv_id: row.conv_id,
    revision: row.revision,
    brief: row.brief,
    reply_to: row.reply_to,
    reply_user_id: row.reply_user_id,
    deleted_at: row.deleted_at,
    edited_at: row.edited_at,
    created_at: row.created_at,
    reply_brief: row.reply_brief ?? null,
  };
  switch (stored.type) {
    case "deleted":
      return { ...base, type: "deleted" };
    case "text":
      return {
        ...base,
        type: "text",
        text: resolveStoredText(row.brief, stored),
      };
    case "sticker": {
      const entry = getStickerEntry(stored.sticker_pack, stored.sticker_id);
      return {
        ...base,
        type: "sticker",
        sticker_pack: stored.sticker_pack,
        sticker_id: stored.sticker_id,
        path: entry?.path ?? "",
        name: entry?.name ?? stored.sticker_id,
      };
    }
  }
}

export function postUserMetadata(
  db: Database,
  posts: readonly PostEntity[],
): UserMetadata[] {
  const ids = [
    ...new Set(
      posts
        .flatMap((post) => [post.user_id, post.reply_user_id])
        .filter((id): id is string => !!id),
    ),
  ];
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT u.id,
        CASE WHEN du.id IS NULL THEN u.handle ELSE NULL END AS handle,
        COALESCE(du.username, u.username) AS username
       FROM users u LEFT JOIN deleted_users du ON du.id = u.id
       WHERE u.id IN (${placeholders})`,
    )
    .all(...ids) as UserMetadata[];
}

export function truncatePosts(posts: PostEntity[]): PostEntity[] {
  return posts.map((post) => {
    let out = post;
    if (post.reply_brief && post.reply_brief.length > 200) {
      out = { ...out, reply_brief: post.reply_brief.slice(0, 200) };
    }
    if (post.type !== "text" || post.text.length <= POST_PREVIEW_LENGTH)
      return out;
    return {
      ...post,
      text: post.text.slice(0, POST_PREVIEW_LENGTH),
      is_truncated: true,
    };
  });
}

export function findPostAccessRow(
  db: Database,
  postId: string,
): PostAccessRow | null {
  return (
    (db
      .prepare(
        `SELECT id, author_id AS user_id, conv_id, content_json, deleted_at
         FROM posts WHERE id = ?`,
      )
      .get(postId) as PostAccessRow | undefined) ?? null
  );
}

export const getPostAccessRow = findPostAccessRow;

export function findSharedVisibleGroup(
  db: Database,
  firstUserId: string,
  secondUserId: string,
): string | null {
  const row = db
    .prepare(
      `SELECT first.group_id
       FROM group_members first
       JOIN group_members second ON second.group_id = first.group_id
       WHERE first.user_id = ? AND second.user_id = ?
         AND first.hide_self = 0 AND second.hide_self = 0
       ORDER BY first.joined_at, first.group_id LIMIT 1`,
    )
    .get(firstUserId, secondUserId) as { group_id: string } | undefined;
  return row?.group_id ?? null;
}

export function usersShareGroup(
  db: Database,
  firstUserId: string,
  secondUserId: string,
): boolean {
  return findSharedVisibleGroup(db, firstUserId, secondUserId) !== null;
}

export function getPostRowid(db: Database, id: string): number | null {
  const row = db.prepare("SELECT sequence FROM posts WHERE id = ?").get(id) as
    { sequence: number } | undefined;
  return row?.sequence ?? null;
}

export function getPostById(db: Database, id: string): PostEntity | null {
  const row = db.prepare(`${POST_WITH_REPLY_SQL} WHERE p.id = ?`).get(id) as
    PostRow | undefined;
  return row ? hydratePost(row) : null;
}

interface PageQuery {
  beforeClause: string;
  afterClause: string;
  order: "ASC" | "DESC";
  revisionOrder?: boolean;
  args: (string | number)[];
  limit: number;
  offset: number;
}

function queryPostsForConv(
  db: Database,
  convId: string,
  input: PageQuery,
): PostEntity[] {
  const rows = db
    .prepare(
      `${POST_WITH_REPLY_SQL}
       WHERE p.conv_id = ? ${input.beforeClause} ${input.afterClause}
       ORDER BY ${input.revisionOrder ? "p.revision ASC, p.sequence ASC" : `p.sequence ${input.order}`}
       LIMIT ? OFFSET ?`,
    )
    .all(convId, ...input.args, input.limit, input.offset) as PostRow[];
  return truncatePosts(rows.map(hydratePost));
}

export function queryFeedPosts(
  db: Database,
  userId: string,
  input: PageQuery,
): PostEntity[] {
  const rows = db
    .prepare(
      `${POST_WITH_REPLY_SQL}
       WHERE p.conv_id IN (
         SELECT g.conv_id FROM group_members gm
         JOIN groups g ON g.id = gm.group_id WHERE gm.user_id = ?
         UNION
         SELECT d.conv_id FROM dms d WHERE d.peer_a = ? OR d.peer_b = ?
       ) ${input.beforeClause} ${input.afterClause}
       ORDER BY ${input.revisionOrder ? "p.revision ASC, p.sequence ASC" : `p.sequence ${input.order}`}
       LIMIT ? OFFSET ?`,
    )
    .all(
      userId,
      userId,
      userId,
      ...input.args,
      input.limit,
      input.offset,
    ) as PostRow[];
  return truncatePosts(rows.map(hydratePost));
}

export function queryGroupPosts(
  db: Database,
  convId: string,
  input: PageQuery,
): PostEntity[] {
  return queryPostsForConv(db, convId, input);
}

export function queryDmPosts(
  db: Database,
  convId: string,
  input: PageQuery,
): PostEntity[] {
  return queryPostsForConv(db, convId, input);
}

export function groupMembershipExists(
  db: Database,
  userId: string,
  groupId: string,
): boolean {
  return !!db
    .prepare("SELECT 1 FROM group_members WHERE user_id = ? AND group_id = ?")
    .get(userId, groupId);
}

export function insertPost(
  db: Database,
  input: {
    id: string;
    userId: string;
    convId: string;
    brief: string;
    contentJson: string;
    replyTo: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO posts (id, author_id, conv_id, brief, content_json, reply_to)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.userId,
    input.convId,
    input.brief,
    input.contentJson,
    input.replyTo,
  );
}

export function updatePostBody(
  db: Database,
  postId: string,
  brief: string,
  contentJson: string,
): void {
  db.prepare(
    `UPDATE posts SET brief = ?, content_json = ?, edited_at = datetime('now')
     WHERE id = ? AND deleted_at IS NULL`,
  ).run(brief, contentJson, postId);
}

export function markPostDeleted(db: Database, postId: string): void {
  db.prepare(
    `UPDATE posts SET brief = '', content_json = '{"type":"deleted"}',
       deleted_at = COALESCE(deleted_at, datetime('now')), edited_at = NULL
     WHERE id = ?`,
  ).run(postId);
}

export function purgePostsByUser(
  db: Database,
  userId: string,
): { posts: Array<{ id: string; conv_id: string }>; convIds: string[] } {
  const posts = db
    .prepare("SELECT id, conv_id FROM posts WHERE author_id = ?")
    .all(userId) as Array<{ id: string; conv_id: string }>;
  db.prepare(
    `UPDATE posts SET brief = '', content_json = '{"type":"deleted"}',
       deleted_at = COALESCE(deleted_at, datetime('now')), edited_at = NULL
     WHERE author_id = ?`,
  ).run(userId);
  return { posts, convIds: [...new Set(posts.map((post) => post.conv_id))] };
}

export function listAdminPosts(
  db: Database,
  input: { q?: string; userId?: string; offset?: number },
): { posts: PostEntity[]; total: number } {
  const q = input.q ?? "";
  const userId = input.userId ?? "";
  const offset = input.offset ?? 0;
  let where = "WHERE 1=1";
  const args: (string | number)[] = [];
  if (q) {
    where += " AND p.brief LIKE ?";
    args.push(`%${q}%`);
  }
  if (userId) {
    where += " AND p.author_id = ?";
    args.push(userId);
  }
  const rows = db
    .prepare(
      `${POST_WITH_REPLY_SQL}
       ${where} ORDER BY p.sequence DESC LIMIT 50 OFFSET ?`,
    )
    .all(...args, offset) as PostRow[];
  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM posts p ${where}`).get(...args) as {
      n: number;
    }
  ).n;
  return { posts: truncatePosts(rows.map(hydratePost)), total };
}

export function parsePostStoredContent(contentJson: string | null | undefined) {
  return parseStoredPostContent(contentJson);
}
