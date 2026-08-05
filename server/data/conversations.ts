import type { Database } from "better-sqlite3";
import type { Conversation } from "@/shared/types/api";

function sortConvEntries(entries: Conversation[]): Conversation[] {
  return entries.sort((a, b) => {
    const aPin = a.pinned ? 1 : 0;
    const bPin = b.pinned ? 1 : 0;
    if (aPin !== bPin) return bPin - aPin;
    if (a.last_at && b.last_at) return b.last_at.localeCompare(a.last_at);
    if (a.last_at) return -1;
    if (b.last_at) return 1;
    return a.name.localeCompare(b.name);
  });
}

export function listConversations(
  db: Database,
  userId: string,
): Conversation[] {
  const groups = db
    .prepare(
      `SELECT
         g.id, g.handle, g.name,
         (g.password_hash IS NOT NULL) AS has_password,
         g.members_hidden, g.admin_only, g.no_leave,
         SUBSTR(COALESCE((SELECT brief FROM posts
                  WHERE group_id = g.id AND is_deleted = 0
                  ORDER BY rowid DESC LIMIT 1), ''), 1, 100) AS last_message,
         (SELECT created_at FROM posts
            WHERE group_id = g.id AND is_deleted = 0
            ORDER BY rowid DESC LIMIT 1) AS last_at,
         crm.last_read_post_id,
         COALESCE(rp.rowid, 0) AS last_read_post_sequence,
         COALESCE(crm.read_updated_at_ms, 0) AS read_updated_at_ms,
         (SELECT id FROM posts p
            WHERE p.group_id = g.id
              AND p.dm_to IS NULL
              AND p.is_deleted = 0
              AND (rp.rowid IS NULL OR p.rowid > rp.rowid)
            ORDER BY p.rowid ASC LIMIT 1) AS first_unread_post_id,
         (SELECT COUNT(*) FROM posts p
            WHERE p.group_id = g.id
              AND p.dm_to IS NULL
              AND p.is_deleted = 0
              AND (rp.rowid IS NULL OR p.rowid > rp.rowid)) AS unread_count,
         (crm.pinned_at IS NOT NULL) AS pinned,
         COALESCE(crm.pinned_updated_at_ms, 0) AS pinned_updated_at_ms,
         COALESCE(crm.muted, 0) AS muted,
         COALESCE(crm.muted_updated_at_ms, 0) AS muted_updated_at_ms
       FROM user_groups ug
       JOIN groups g ON ug.group_id = g.id
       LEFT JOIN conversation_user_state crm
         ON crm.user_id = ug.user_id
        AND crm.conversation_type = 'group'
        AND crm.conversation_id = g.id
       LEFT JOIN posts rp ON rp.id = crm.last_read_post_id
       WHERE ug.user_id = ?`,
    )
    .all(userId) as Array<{
    id: string;
    handle: string | null;
    name: string;
    has_password: number;
    members_hidden: number;
    admin_only: number;
    no_leave: number;
    last_message: string | null;
    last_at: string | null;
    last_read_post_id: string | null;
    last_read_post_sequence: number;
    read_updated_at_ms: number;
    first_unread_post_id: string | null;
    unread_count: number;
    pinned: number;
    pinned_updated_at_ms: number;
    muted: number;
    muted_updated_at_ms: number;
  }>;

  const dms = db
    .prepare(
      `SELECT
         dp.partner_id                            AS id,
         lp.created_at                            AS last_at,
         COALESCE(u.username, du.username, '已注销') AS name,
         COALESCE(u.handle, NULL)                 AS handle,
         SUBSTR(COALESCE(lp.brief, ''), 1, 100) AS last_message,
         crm.last_read_post_id,
         COALESCE(rp.rowid, 0) AS last_read_post_sequence,
         COALESCE(crm.read_updated_at_ms, 0) AS read_updated_at_ms,
         (SELECT id FROM posts p
            WHERE p.dm_to IS NOT NULL
              AND p.group_id IS NULL
              AND p.is_deleted = 0
              AND ((p.user_id = ? AND p.dm_to = dp.partner_id)
                OR (p.user_id = dp.partner_id AND p.dm_to = ?))
              AND (rp.rowid IS NULL OR p.rowid > rp.rowid)
            ORDER BY p.rowid ASC LIMIT 1) AS first_unread_post_id,
         (SELECT COUNT(*) FROM posts p
            WHERE p.dm_to IS NOT NULL
              AND p.group_id IS NULL
              AND p.is_deleted = 0
              AND ((p.user_id = ? AND p.dm_to = dp.partner_id)
                OR (p.user_id = dp.partner_id AND p.dm_to = ?))
              AND (rp.rowid IS NULL OR p.rowid > rp.rowid)) AS unread_count,
         (crm.pinned_at IS NOT NULL) AS pinned,
         COALESCE(crm.pinned_updated_at_ms, 0) AS pinned_updated_at_ms,
         COALESCE(crm.muted, 0) AS muted,
         COALESCE(crm.muted_updated_at_ms, 0) AS muted_updated_at_ms
       FROM (
         SELECT
           CASE WHEN user_id = ? THEN dm_to ELSE user_id END AS partner_id,
           MAX(rowid) AS last_rowid
         FROM posts
         WHERE user_id IS NOT NULL
           AND (user_id = ? OR dm_to = ?)
           AND dm_to IS NOT NULL
           AND group_id IS NULL
         GROUP BY partner_id
       ) dp
       LEFT JOIN users u ON u.id = dp.partner_id
         AND NOT EXISTS (SELECT 1 FROM deleted_users x WHERE x.id = u.id)
       LEFT JOIN deleted_users du ON du.id = dp.partner_id
       LEFT JOIN conversation_user_state crm
         ON crm.user_id = ?
        AND crm.conversation_type = 'dm'
        AND crm.conversation_id = dp.partner_id
       LEFT JOIN posts rp ON rp.id = crm.last_read_post_id
       LEFT JOIN posts lp ON lp.rowid = dp.last_rowid`,
    )
    .all(
      userId,
      userId,
      userId,
      userId,
      userId,
      userId,
      userId,
      userId,
    ) as Array<{
    id: string;
    handle: string | null;
    name: string;
    last_message: string | null;
    last_at: string | null;
    last_read_post_id: string | null;
    last_read_post_sequence: number;
    read_updated_at_ms: number;
    first_unread_post_id: string | null;
    unread_count: number;
    pinned: number;
    pinned_updated_at_ms: number;
    muted: number;
    muted_updated_at_ms: number;
  }>;

  return sortConvEntries([
    ...groups.map<Conversation>((g) => ({
      type: "group",
      id: g.id,
      handle: g.handle,
      name: g.name,
      has_password: g.has_password,
      members_hidden: g.members_hidden,
      admin_only: g.admin_only,
      no_leave: g.no_leave,
      last_message: g.last_message,
      last_at: g.last_at,
      last_read_post_id: g.last_read_post_id,
      last_read_post_sequence: g.last_read_post_sequence,
      read_updated_at_ms: g.read_updated_at_ms,
      first_unread_post_id: g.first_unread_post_id,
      unread_count: g.unread_count,
      pinned: g.pinned,
      pinned_updated_at_ms: g.pinned_updated_at_ms,
      muted: g.muted,
      muted_updated_at_ms: g.muted_updated_at_ms,
    })),
    ...dms.map<Conversation>((d) => ({
      type: "dm",
      id: d.id,
      handle: d.handle,
      name: d.name,
      has_password: 0,
      members_hidden: 0,
      admin_only: 0,
      no_leave: 0,
      last_message: d.last_message,
      last_at: d.last_at,
      last_read_post_id: d.last_read_post_id,
      last_read_post_sequence: d.last_read_post_sequence,
      read_updated_at_ms: d.read_updated_at_ms,
      first_unread_post_id: d.first_unread_post_id,
      unread_count: d.unread_count,
      pinned: d.pinned,
      pinned_updated_at_ms: d.pinned_updated_at_ms,
      muted: d.muted,
      muted_updated_at_ms: d.muted_updated_at_ms,
    })),
  ]);
}

export function getConversationEntry(
  db: Database,
  userId: string,
  type: "group" | "dm",
  id: string,
): Conversation | null {
  return (
    listConversations(db, userId).find(
      (entry) => entry.type === type && entry.id === id,
    ) ?? null
  );
}

export function isGroupConversationMember(
  db: Database,
  userId: string,
  groupId: string,
): boolean {
  return !!db
    .prepare("SELECT 1 FROM user_groups WHERE user_id = ? AND group_id = ?")
    .get(userId, groupId);
}

export function dmConversationExists(
  db: Database,
  userId: string,
  partnerId: string,
): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM posts
       WHERE dm_to IS NOT NULL
         AND group_id IS NULL
         AND is_deleted = 0
         AND ((user_id = ? AND dm_to = ?) OR (user_id = ? AND dm_to = ?))
       LIMIT 1`,
    )
    .get(userId, partnerId, partnerId, userId);
}

export function listConversationGroupMemberIds(
  db: Database,
  groupId: string,
): string[] {
  return (
    db
      .prepare("SELECT user_id FROM user_groups WHERE group_id = ?")
      .all(groupId) as { user_id: string }[]
  ).map((row) => row.user_id);
}

export function getGroupConversationPostRow(
  db: Database,
  input: { postId: string; groupId: string },
): { id: string; rowid: number } | null {
  return (
    (db
      .prepare(
        "SELECT id, rowid FROM posts WHERE id = ? AND group_id = ? AND dm_to IS NULL",
      )
      .get(input.postId, input.groupId) as
      { id: string; rowid: number } | undefined) ?? null
  );
}

export function getDmConversationPostRow(
  db: Database,
  input: { postId: string; userId: string; partnerId: string },
): { id: string; rowid: number } | null {
  return (
    (db
      .prepare(
        `SELECT id, rowid FROM posts
         WHERE id = ?
           AND dm_to IS NOT NULL
           AND group_id IS NULL
           AND ((user_id = ? AND dm_to = ?) OR (user_id = ? AND dm_to = ?))`,
      )
      .get(
        input.postId,
        input.userId,
        input.partnerId,
        input.partnerId,
        input.userId,
      ) as { id: string; rowid: number } | undefined) ?? null
  );
}

export function getConversationLastReadRowid(
  db: Database,
  input: { userId: string; type: "group" | "dm"; id: string },
): number | null {
  const row = db
    .prepare(
      `SELECT p.rowid AS rowid
       FROM conversation_user_state crm
       JOIN posts p ON p.id = crm.last_read_post_id
       WHERE crm.user_id = ?
         AND crm.conversation_type = ?
         AND crm.conversation_id = ?`,
    )
    .get(input.userId, input.type, input.id) as { rowid: number } | undefined;
  return row?.rowid ?? null;
}

export interface ConversationReadState {
  postId: string | null;
  sequence: number;
  updatedAt: number;
}

export function getConversationReadState(
  db: Database,
  input: { userId: string; type: "group" | "dm"; id: string },
): ConversationReadState {
  const row = db
    .prepare(
      `SELECT s.last_read_post_id AS postId,
              COALESCE(p.rowid, 0) AS sequence,
              s.read_updated_at_ms AS updatedAt
       FROM conversation_user_state s
       LEFT JOIN posts p ON p.id = s.last_read_post_id
       WHERE s.user_id = ?
         AND s.conversation_type = ?
         AND s.conversation_id = ?`,
    )
    .get(input.userId, input.type, input.id) as
    ConversationReadState | undefined;
  return row ?? { postId: null, sequence: 0, updatedAt: 0 };
}

export function upsertConversationReadState(
  db: Database,
  input: {
    userId: string;
    type: "group" | "dm";
    id: string;
    postId: string;
    updatedAt: number;
  },
): void {
  db.prepare(
    `INSERT INTO conversation_user_state
       (user_id, conversation_type, conversation_id, last_read_post_id, read_updated_at_ms, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, conversation_type, conversation_id) DO UPDATE SET
       last_read_post_id = excluded.last_read_post_id,
       read_updated_at_ms = excluded.read_updated_at_ms,
       updated_at = datetime('now')`,
  ).run(input.userId, input.type, input.id, input.postId, input.updatedAt);
}

export function setConversationPinnedValue(
  db: Database,
  input: {
    userId: string;
    type: "group" | "dm";
    id: string;
    pinned: boolean;
    updatedAt: number;
  },
): void {
  db.prepare(
    `INSERT INTO conversation_user_state
       (user_id, conversation_type, conversation_id, pinned_at,
        pinned_updated_at_ms, updated_at)
     VALUES (?, ?, ?, CASE WHEN ? THEN datetime('now') ELSE NULL END, ?, datetime('now'))
     ON CONFLICT(user_id, conversation_type, conversation_id) DO UPDATE SET
       pinned_at = CASE WHEN ? THEN datetime('now') ELSE NULL END,
       pinned_updated_at_ms = excluded.pinned_updated_at_ms,
       updated_at = datetime('now')
     WHERE excluded.pinned_updated_at_ms >= conversation_user_state.pinned_updated_at_ms`,
  ).run(
    input.userId,
    input.type,
    input.id,
    input.pinned ? 1 : 0,
    input.updatedAt,
    input.pinned ? 1 : 0,
  );
}

export function getConversationPinnedState(
  db: Database,
  input: { userId: string; type: "group" | "dm"; id: string },
): ConversationMutedState {
  const row = db
    .prepare(
      `SELECT (pinned_at IS NOT NULL) AS value,
              pinned_updated_at_ms AS updatedAt
       FROM conversation_user_state
       WHERE user_id = ? AND conversation_type = ? AND conversation_id = ?`,
    )
    .get(input.userId, input.type, input.id) as
    { value: number; updatedAt: number } | undefined;
  return row
    ? { value: !!row.value, updatedAt: row.updatedAt }
    : { value: false, updatedAt: 0 };
}

export function setConversationMutedValue(
  db: Database,
  input: {
    userId: string;
    type: "group" | "dm";
    id: string;
    muted: boolean;
    updatedAt: number;
  },
): void {
  db.prepare(
    `INSERT INTO conversation_user_state
       (user_id, conversation_type, conversation_id, muted, muted_updated_at_ms, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, conversation_type, conversation_id) DO UPDATE SET
       muted = excluded.muted,
       muted_updated_at_ms = excluded.muted_updated_at_ms,
       updated_at = datetime('now')
     WHERE excluded.muted_updated_at_ms >= conversation_user_state.muted_updated_at_ms`,
  ).run(
    input.userId,
    input.type,
    input.id,
    input.muted ? 1 : 0,
    input.updatedAt,
  );
}

export interface ConversationMutedState {
  value: boolean;
  updatedAt: number;
}

export function getConversationMutedState(
  db: Database,
  input: { userId: string; type: "group" | "dm"; id: string },
): ConversationMutedState {
  const row = db
    .prepare(
      `SELECT muted AS value, muted_updated_at_ms AS updatedAt
       FROM conversation_user_state
       WHERE user_id = ? AND conversation_type = ? AND conversation_id = ?`,
    )
    .get(input.userId, input.type, input.id) as
    { value: number; updatedAt: number } | undefined;
  return row
    ? { value: !!row.value, updatedAt: row.updatedAt }
    : { value: false, updatedAt: 0 };
}

export function getConversationComposeDraftValue(
  db: Database,
  input: { userId: string; type: "group" | "dm"; id: string },
): { draft: string; updatedAt: number } {
  const row = db
    .prepare(
      `SELECT compose_draft, compose_draft_updated_at
       FROM conversation_user_state
       WHERE user_id = ?
         AND conversation_type = ?
         AND conversation_id = ?`,
    )
    .get(input.userId, input.type, input.id) as
    | { compose_draft: string | null; compose_draft_updated_at: number }
    | undefined;
  return {
    draft: row?.compose_draft ?? "",
    updatedAt: row?.compose_draft_updated_at ?? 0,
  };
}

export function clearConversationComposeDraft(
  db: Database,
  input: {
    userId: string;
    type: "group" | "dm";
    id: string;
    updatedAt: number;
  },
): void {
  db.prepare(
    `UPDATE conversation_user_state
     SET compose_draft = NULL, compose_draft_updated_at = ?, updated_at = datetime('now')
     WHERE user_id = ? AND conversation_type = ? AND conversation_id = ?
       AND compose_draft_updated_at <= ?`,
  ).run(input.updatedAt, input.userId, input.type, input.id, input.updatedAt);
}

export function upsertConversationComposeDraft(
  db: Database,
  input: {
    userId: string;
    type: "group" | "dm";
    id: string;
    draft: string;
    updatedAt: number;
  },
): void {
  db.prepare(
    `INSERT INTO conversation_user_state
       (user_id, conversation_type, conversation_id, compose_draft, compose_draft_updated_at, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, conversation_type, conversation_id) DO UPDATE SET
       compose_draft = excluded.compose_draft,
       compose_draft_updated_at = excluded.compose_draft_updated_at,
       updated_at = datetime('now')
     WHERE excluded.compose_draft_updated_at >= conversation_user_state.compose_draft_updated_at`,
  ).run(input.userId, input.type, input.id, input.draft, input.updatedAt);
}

export function purgeConversationStateForUser(
  db: Database,
  userId: string,
): void {
  db.prepare(
    `DELETE FROM conversation_user_state
     WHERE user_id = ? OR (conversation_type = 'dm' AND conversation_id = ?)`,
  ).run(userId, userId);
}
