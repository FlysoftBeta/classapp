import type { Database } from "better-sqlite3";
import type { Post } from "@/shared/types/api";
import { getStickerEntry } from "@/server/infra/stickerLoader";
import {
  loadStoredContent,
  parseStoredPostContent,
  resolveStoredText,
} from "@/server/services/postContent";
import { POST_PREVIEW_LENGTH } from "@/shared/validation/posts";

export interface PostRow {
  id: string;
  sequence?: number;
  user_id: string | null;
  brief: string;
  content_json: string;
  group_id: string | null;
  dm_to: string | null;
  reply_to: string | null;
  is_deleted: number;
  deleted_at: string | null;
  edited_at: string | null;
  created_at: string;
  username?: string | null;
  handle?: string | null;
  reply_username?: string | null;
  reply_handle?: string | null;
  reply_brief?: string | null;
}

export interface PostAccessRow {
  id: string;
  user_id: string | null;
  group_id: string | null;
  dm_to: string | null;
  content_json: string | null;
  is_deleted: number;
}

export function findPostAccessRow(
  db: Database,
  postId: string,
): PostAccessRow | null {
  return (
    (db
      .prepare(
        "SELECT id, user_id, group_id, dm_to, content_json, is_deleted FROM posts WHERE id = ?",
      )
      .get(postId) as PostAccessRow | undefined) ?? null
  );
}

export function usersShareGroup(
  db: Database,
  firstUserId: string,
  secondUserId: string,
): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM user_groups ug1
     JOIN user_groups ug2 ON ug1.group_id = ug2.group_id
     WHERE ug1.user_id = ? AND ug2.user_id = ? LIMIT 1`,
    )
    .get(firstUserId, secondUserId);
}

const REPLY_PREVIEW_LENGTH = 200;

export const POST_WITH_REPLY_SQL = `
  SELECT p.*, p.rowid AS sequence,
    COALESCE(u.username, du.username) AS username, u.handle,
    r.brief as reply_brief,
    COALESCE(ru.username, rdu.username) as reply_username,
    ru.handle as reply_handle
  FROM posts p
  LEFT JOIN users u ON p.user_id = u.id
    AND NOT EXISTS (SELECT 1 FROM deleted_users x WHERE x.id = u.id)
  LEFT JOIN deleted_users du ON p.user_id = du.id
  LEFT JOIN posts r ON p.reply_to = r.id
  LEFT JOIN users ru ON r.user_id = ru.id
    AND NOT EXISTS (SELECT 1 FROM deleted_users x WHERE x.id = ru.id)
  LEFT JOIN deleted_users rdu ON r.user_id = rdu.id
`;

export function hydratePost(row: PostRow): Post {
  const stored = loadStoredContent(row);
  const base = {
    id: row.id,
    sequence: row.sequence,
    user_id: row.user_id,
    brief: row.brief,
    group_id: row.group_id,
    dm_to: row.dm_to,
    reply_to: row.reply_to,
    is_deleted: row.is_deleted,
    deleted_at: row.deleted_at,
    edited_at: row.edited_at,
    created_at: row.created_at,
    username: row.username,
    handle: row.handle,
    reply_username: row.reply_username,
    reply_handle: row.reply_handle,
    reply_brief: row.reply_brief,
  };
  switch (stored.type) {
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

export function truncatePosts(posts: Post[]): Post[] {
  return posts.map((post) => {
    let out: Post = post;
    if (post.reply_brief && post.reply_brief.length > REPLY_PREVIEW_LENGTH) {
      out = {
        ...out,
        reply_brief: post.reply_brief.slice(0, REPLY_PREVIEW_LENGTH),
      };
    }
    if (post.type !== "text" || post.text.length <= POST_PREVIEW_LENGTH) {
      return out;
    }
    return {
      ...post,
      text: post.text.slice(0, POST_PREVIEW_LENGTH),
      is_truncated: true,
    };
  });
}

export function getPostRowid(db: Database, id: string): number | null {
  const row = db.prepare("SELECT rowid FROM posts WHERE id = ?").get(id) as
    { rowid: number } | undefined;
  return row?.rowid ?? null;
}

export function getPostById(db: Database, id: string): Post | null {
  const row =
    (db.prepare(`${POST_WITH_REPLY_SQL} WHERE p.id = ?`).get(id) as
      PostRow | undefined) ?? null;
  return row ? hydratePost(row) : null;
}

export function getPostAccessRow(
  db: Database,
  id: string,
): {
  id: string;
  user_id: string | null;
  group_id: string | null;
  dm_to: string | null;
  content_json: string | null;
  is_deleted: number;
} | null {
  return (
    (db
      .prepare(
        "SELECT id, user_id, group_id, dm_to, content_json, is_deleted FROM posts WHERE id = ?",
      )
      .get(id) as
      | {
          id: string;
          user_id: string | null;
          group_id: string | null;
          dm_to: string | null;
          content_json: string | null;
          is_deleted: number;
        }
      | undefined) ?? null
  );
}

export function queryFeedPosts(
  db: Database,
  userId: string,
  input: {
    beforeClause: string;
    afterClause: string;
    order: "ASC" | "DESC";
    args: (string | number)[];
    limit: number;
    offset: number;
  },
): Post[] {
  const rows = db
    .prepare(
      `${POST_WITH_REPLY_SQL}
       WHERE (
         (p.dm_to IS NULL AND p.group_id IN (
           SELECT group_id FROM user_groups WHERE user_id = ?
         ))
         OR (p.dm_to IS NOT NULL AND (p.user_id = ? OR p.dm_to = ?))
       )
       ${input.beforeClause} ${input.afterClause}
       ORDER BY p.rowid ${input.order}
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
  groupId: string,
  input: {
    beforeClause: string;
    afterClause: string;
    order: "ASC" | "DESC";
    args: (string | number)[];
    limit: number;
    offset: number;
  },
): Post[] {
  const rows = db
    .prepare(
      `${POST_WITH_REPLY_SQL}
       WHERE p.group_id = ? AND p.dm_to IS NULL
       ${input.beforeClause} ${input.afterClause}
       ORDER BY p.rowid ${input.order}
       LIMIT ? OFFSET ?`,
    )
    .all(groupId, ...input.args, input.limit, input.offset) as PostRow[];
  return truncatePosts(rows.map(hydratePost));
}

export function queryDmPosts(
  db: Database,
  userId: string,
  partnerId: string,
  input: {
    beforeClause: string;
    afterClause: string;
    order: "ASC" | "DESC";
    args: (string | number)[];
    limit: number;
    offset: number;
  },
): Post[] {
  const rows = db
    .prepare(
      `${POST_WITH_REPLY_SQL}
       WHERE p.dm_to IS NOT NULL
         AND ((p.user_id = ? AND p.dm_to = ?) OR (p.user_id = ? AND p.dm_to = ?))
         ${input.beforeClause} ${input.afterClause}
         ORDER BY p.rowid ${input.order}
         LIMIT ? OFFSET ?`,
    )
    .all(
      userId,
      partnerId,
      partnerId,
      userId,
      ...input.args,
      input.limit,
      input.offset,
    ) as PostRow[];
  return truncatePosts(rows.map(hydratePost));
}

export function groupMembershipExists(
  db: Database,
  userId: string,
  groupId: string,
): boolean {
  return !!db
    .prepare("SELECT 1 FROM user_groups WHERE user_id = ? AND group_id = ?")
    .get(userId, groupId);
}

export function insertPost(
  db: Database,
  input: {
    id: string;
    userId: string;
    brief: string;
    contentJson: string;
    groupId: string | null;
    dmTo: string | null;
    replyTo: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO posts (id, user_id, content, brief, content_json, group_id, dm_to, reply_to)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.userId,
    input.brief,
    input.brief,
    input.contentJson,
    input.groupId,
    input.dmTo,
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
    `UPDATE posts SET content = ?, brief = ?, content_json = ?, edited_at = datetime('now')
     WHERE id = ?`,
  ).run(brief, brief, contentJson, postId);
}

export function markPostDeleted(
  db: Database,
  postId: string,
  emptyContentJson: string,
): void {
  db.prepare(
    `UPDATE posts SET is_deleted = 1, deleted_at = datetime('now'),
     content = '', brief = '', content_json = ?
     WHERE id = ?`,
  ).run(emptyContentJson, postId);
}

export function deletePostRow(db: Database, postId: string): void {
  db.prepare("DELETE FROM posts WHERE id = ?").run(postId);
}

export function purgePostsByUser(
  db: Database,
  userId: string,
): {
  posts: Array<{
    id: string;
    user_id: string | null;
    group_id: string | null;
    dm_to: string | null;
  }>;
  groupIds: string[];
  peerIds: string[];
} {
  const posts = db
    .prepare(
      `SELECT id, user_id, group_id, dm_to FROM posts
       WHERE user_id = ? OR dm_to = ?`,
    )
    .all(userId, userId) as Array<{
    id: string;
    user_id: string | null;
    group_id: string | null;
    dm_to: string | null;
  }>;
  const groupIds = (
    db
      .prepare(
        `SELECT DISTINCT group_id FROM posts
         WHERE user_id = ? AND group_id IS NOT NULL`,
      )
      .all(userId) as { group_id: string }[]
  ).map((row) => row.group_id);
  const peerIds = (
    db
      .prepare(
        `SELECT DISTINCT CASE WHEN user_id = ? THEN dm_to ELSE user_id END AS peer_id
         FROM posts
         WHERE dm_to IS NOT NULL AND (user_id = ? OR dm_to = ?)`,
      )
      .all(userId, userId, userId) as { peer_id: string | null }[]
  )
    .map((row) => row.peer_id)
    .filter((id): id is string => id !== null && id !== userId);
  db.prepare("DELETE FROM posts WHERE user_id = ? OR dm_to = ?").run(
    userId,
    userId,
  );
  return { posts, groupIds, peerIds };
}

export function listAdminPosts(
  db: Database,
  input: { q?: string; userId?: string; offset?: number },
): { posts: Post[]; total: number } {
  const q = input.q ?? "";
  const userId = input.userId ?? "";
  const offset = input.offset ?? 0;
  let query = `
    SELECT p.*, COALESCE(u.username, du.username) AS username,
           u.handle, g.name as group_name
    FROM posts p
    LEFT JOIN users u ON p.user_id = u.id
      AND NOT EXISTS (SELECT 1 FROM deleted_users x WHERE x.id = u.id)
    LEFT JOIN deleted_users du ON p.user_id = du.id
    LEFT JOIN groups g ON p.group_id = g.id
    WHERE 1=1
  `;
  const args: (string | number)[] = [];
  if (q) {
    query += ` AND p.brief LIKE ?`;
    args.push(`%${q}%`);
  }
  if (userId) {
    query += ` AND p.user_id = ?`;
    args.push(userId);
  }
  query += ` ORDER BY p.created_at DESC LIMIT 50 OFFSET ?`;
  args.push(offset);
  const rawPosts = db.prepare(query).all(...args) as PostRow[];
  const posts = truncatePosts(rawPosts.map(hydratePost));

  let countQuery = "SELECT COUNT(*) as n FROM posts p WHERE 1=1";
  const countArgs: (string | number)[] = [];
  if (q) {
    countQuery += " AND p.brief LIKE ?";
    countArgs.push(`%${q}%`);
  }
  if (userId) {
    countQuery += " AND p.user_id = ?";
    countArgs.push(userId);
  }
  const total = (db.prepare(countQuery).get(...countArgs) as { n: number }).n;
  return { posts, total };
}

export function parsePostStoredContent(contentJson: string | null | undefined) {
  return parseStoredPostContent(contentJson);
}
