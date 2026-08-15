import type { Database } from "better-sqlite3";
import type { ConversationEntity } from "@/shared/types/api";
import {
  dmConvId,
  groupConvId,
  orderedDmPeers,
  parseConvId,
} from "@/shared/conversations/id";

function sortConvEntries(entries: ConversationEntity[]): ConversationEntity[] {
  return entries.sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return b.pinned - a.pinned;
    if (a.last_at && b.last_at) return b.last_at.localeCompare(a.last_at);
    if (a.last_at) return -1;
    if (b.last_at) return 1;
    const left = a.type === "group" ? a.name : a.id;
    const right = b.type === "group" ? b.name : b.id;
    return left.localeCompare(right);
  });
}

const LAST_MESSAGE_SQL = `CASE
  WHEN json_extract(lp.content_json, '$.type') = 'deleted' THEN '消息已删除'
  ELSE SUBSTR(COALESCE(lp.brief, ''), 1, 100)
END`;

export function listConversations(
  db: Database,
  userId: string,
): ConversationEntity[] {
  const groups = db
    .prepare(
      `SELECT g.id, g.conv_id, g.revision, g.handle, g.name, g.type AS group_type,
         (g.password_hash IS NOT NULL) AS has_password,
         g.members_hidden, g.admin_only, g.no_leave,
         (COALESCE(me.is_muted, 0) = 0 AND
           (g.admin_only = 0 OR EXISTS (
             SELECT 1 FROM user_admin_roles ar
             WHERE ar.user_id = me.id AND ar.role = 'community_manager'
           ))) AS can_post,
         (g.no_leave = 0) AS can_leave,
         ${LAST_MESSAGE_SQL} AS last_message,
         lp.created_at AS last_at,
         state.last_read_post_id,
         COALESCE(rp.sequence, 0) AS last_read_post_sequence,
         COALESCE(state.read_updated_at_ms, 0) AS read_updated_at_ms,
         (SELECT p.id FROM posts p
            WHERE p.conv_id = g.conv_id
              AND (rp.sequence IS NULL OR p.sequence > rp.sequence)
            ORDER BY p.sequence LIMIT 1) AS first_unread_post_id,
         (SELECT COUNT(*) FROM posts p
            WHERE p.conv_id = g.conv_id
              AND (rp.sequence IS NULL OR p.sequence > rp.sequence)) AS unread_count,
         (state.pinned_at IS NOT NULL) AS pinned,
         COALESCE(state.pinned_updated_at_ms, 0) AS pinned_updated_at_ms,
         COALESCE(state.muted, 0) AS muted,
         COALESCE(state.muted_updated_at_ms, 0) AS muted_updated_at_ms
       FROM group_members member
       JOIN groups g ON g.id = member.group_id
       JOIN users me ON me.id = member.user_id
       LEFT JOIN convs_user state
         ON state.user_id = member.user_id AND state.conv_id = g.conv_id
       LEFT JOIN posts rp ON rp.id = state.last_read_post_id
       LEFT JOIN posts lp ON lp.sequence = (
         SELECT p.sequence FROM posts p WHERE p.conv_id = g.conv_id
         ORDER BY p.sequence DESC LIMIT 1)
       WHERE member.user_id = :uid`,
    )
    .all({ uid: userId }) as Array<Record<string, unknown>>;

  const dms = db
    .prepare(
      `SELECT d.conv_id, d.revision, NULL AS group_type,
         CASE WHEN d.peer_a = :uid THEN d.peer_b ELSE d.peer_a END AS id,
         (COALESCE(me.is_muted, 0) = 0) AS can_post,
         0 AS can_leave,
         ${LAST_MESSAGE_SQL} AS last_message,
         lp.created_at AS last_at,
         state.last_read_post_id,
         COALESCE(rp.sequence, 0) AS last_read_post_sequence,
         COALESCE(state.read_updated_at_ms, 0) AS read_updated_at_ms,
         (SELECT p.id FROM posts p
            WHERE p.conv_id = d.conv_id
              AND (rp.sequence IS NULL OR p.sequence > rp.sequence)
            ORDER BY p.sequence LIMIT 1) AS first_unread_post_id,
         (SELECT COUNT(*) FROM posts p
            WHERE p.conv_id = d.conv_id
              AND (rp.sequence IS NULL OR p.sequence > rp.sequence)) AS unread_count,
         (state.pinned_at IS NOT NULL) AS pinned,
         COALESCE(state.pinned_updated_at_ms, 0) AS pinned_updated_at_ms,
         COALESCE(state.muted, 0) AS muted,
         COALESCE(state.muted_updated_at_ms, 0) AS muted_updated_at_ms
       FROM dms d
       JOIN users me ON me.id = :uid
       LEFT JOIN convs_user state ON state.user_id = :uid AND state.conv_id = d.conv_id
       LEFT JOIN posts rp ON rp.id = state.last_read_post_id
       LEFT JOIN posts lp ON lp.sequence = (
         SELECT p.sequence FROM posts p WHERE p.conv_id = d.conv_id
         ORDER BY p.sequence DESC LIMIT 1)
       WHERE d.peer_a = :uid OR d.peer_b = :uid`,
    )
    .all({ uid: userId }) as Array<Record<string, unknown>>;

  return sortConvEntries([
    ...groups.map((row) => ({
      ...row,
      type: "group" as const,
      group_type: String(row.group_type),
      handle: String(row.handle),
      name: String(row.name),
      can_post: !!row.can_post,
      can_leave: !!row.can_leave,
    })) as ConversationEntity[],
    ...dms.map((row) => ({
      ...row,
      type: "dm" as const,
      group_type: null,
      has_password: 0,
      members_hidden: 0,
      admin_only: 0,
      no_leave: 0,
      can_post: !!row.can_post,
      can_leave: !!row.can_leave,
    })) as ConversationEntity[],
  ]);
}

export function listConversationRevisions(
  db: Database,
  userId: string,
): Array<{ conv_id: string; revision: number; revision_sum: string }> {
  return db
    .prepare(
      `SELECT g.conv_id, g.revision,
              CAST(COALESCE((SELECT SUM(p.revision) FROM posts p
                             WHERE p.conv_id = g.conv_id), 0) AS TEXT) AS revision_sum
       FROM group_members gm
       JOIN groups g ON g.id = gm.group_id WHERE gm.user_id = ?
       UNION ALL
       SELECT d.conv_id, d.revision,
              CAST(COALESCE((SELECT SUM(p.revision) FROM posts p
                             WHERE p.conv_id = d.conv_id), 0) AS TEXT) AS revision_sum
       FROM dms d WHERE d.peer_a = ? OR d.peer_b = ?`,
    )
    .all(userId, userId, userId) as Array<{
    conv_id: string;
    revision: number;
    revision_sum: string;
  }>;
}

export function getConversationEntry(
  db: Database,
  userId: string,
  type: "group" | "dm",
  id: string,
): ConversationEntity | null {
  return (
    listConversations(db, userId).find(
      (row) => row.type === type && row.id === id,
    ) ?? null
  );
}

export function isGroupConversationMember(
  db: Database,
  userId: string,
  groupId: string,
): boolean {
  return !!db
    .prepare("SELECT 1 FROM group_members WHERE user_id = ? AND group_id = ?")
    .get(userId, groupId);
}

export function dmConversationExists(
  db: Database,
  userId: string,
  partnerId: string,
): boolean {
  return !!db
    .prepare("SELECT 1 FROM dms WHERE conv_id = ?")
    .get(dmConvId(userId, partnerId));
}

export function findDmConversation(
  db: Database,
  first: string,
  second: string,
): { conv_id: string } | null {
  return (
    (db
      .prepare("SELECT conv_id FROM dms WHERE conv_id = ?")
      .get(dmConvId(first, second)) as { conv_id: string } | undefined) ?? null
  );
}

export function insertDmConversation(
  db: Database,
  first: string,
  second: string,
  proofGroupId: string,
): string {
  const [peerA, peerB] = orderedDmPeers(first, second);
  const id = `${peerA}:${peerB}`;
  const convId = dmConvId(peerA, peerB);
  db.prepare(
    `INSERT OR IGNORE INTO dms (id, conv_id, peer_a, peer_b, proof_group_id)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, convId, peerA, peerB, proofGroupId);
  return convId;
}

export function conversationExists(db: Database, convId: string): boolean {
  const parsed = parseConvId(convId);
  if (!parsed) return false;
  const table = parsed.type === "group" ? "groups" : "dms";
  return !!db.prepare(`SELECT 1 FROM ${table} WHERE conv_id = ?`).get(convId);
}

export function listConversationGroupMemberIds(
  db: Database,
  groupId: string,
): string[] {
  return (
    db
      .prepare("SELECT user_id FROM group_members WHERE group_id = ?")
      .all(groupId) as Array<{ user_id: string }>
  ).map((row) => row.user_id);
}

export function listConversationParticipantIds(
  db: Database,
  convId: string,
): string[] {
  const parsed = parseConvId(convId);
  if (!parsed) return [];
  if (parsed.type === "group")
    return listConversationGroupMemberIds(db, parsed.groupId);
  return [parsed.peerA, parsed.peerB];
}

function getConversationPostRow(db: Database, postId: string, convId: string) {
  return (
    (db
      .prepare("SELECT id, sequence FROM posts WHERE id = ? AND conv_id = ?")
      .get(postId, convId) as { id: string; sequence: number } | undefined) ??
    null
  );
}

export function getGroupConversationPostRow(
  db: Database,
  input: { postId: string; groupId: string },
): { id: string; rowid: number } | null {
  const row = getConversationPostRow(
    db,
    input.postId,
    groupConvId(input.groupId),
  );
  return row ? { id: row.id, rowid: row.sequence } : null;
}

export function getDmConversationPostRow(
  db: Database,
  input: { postId: string; userId: string; partnerId: string },
): { id: string; rowid: number } | null {
  const row = getConversationPostRow(
    db,
    input.postId,
    dmConvId(input.userId, input.partnerId),
  );
  return row ? { id: row.id, rowid: row.sequence } : null;
}

function refConvId(input: {
  userId: string;
  type: "group" | "dm";
  id: string;
}): string {
  return input.type === "group"
    ? groupConvId(input.id)
    : dmConvId(input.userId, input.id);
}

export interface ConversationReadState {
  postId: string | null;
  sequence: number;
  updatedAt: number;
}

export function getConversationLastReadRowid(
  db: Database,
  input: { userId: string; type: "group" | "dm"; id: string },
): number | null {
  return getConversationReadState(db, input).sequence || null;
}

export function getConversationReadState(
  db: Database,
  input: { userId: string; type: "group" | "dm"; id: string },
): ConversationReadState {
  const row = db
    .prepare(
      `SELECT s.last_read_post_id AS postId, COALESCE(p.sequence, 0) AS sequence,
              s.read_updated_at_ms AS updatedAt
       FROM convs_user s LEFT JOIN posts p ON p.id = s.last_read_post_id
       WHERE s.user_id = ? AND s.conv_id = ?`,
    )
    .get(input.userId, refConvId(input)) as ConversationReadState | undefined;
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
    `INSERT INTO convs_user (user_id, conv_id, last_read_post_id, read_updated_at_ms, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, conv_id) DO UPDATE SET
       last_read_post_id = excluded.last_read_post_id,
       read_updated_at_ms = excluded.read_updated_at_ms,
       updated_at = datetime('now')`,
  ).run(input.userId, refConvId(input), input.postId, input.updatedAt);
}

export interface ConversationMutedState {
  value: boolean;
  updatedAt: number;
}

function setBooleanState(
  db: Database,
  input: {
    userId: string;
    type: "group" | "dm";
    id: string;
    value: boolean;
    updatedAt: number;
  },
  field: "pinned" | "muted",
): void {
  const convId = refConvId(input);
  if (field === "pinned") {
    db.prepare(
      `INSERT INTO convs_user (user_id, conv_id, pinned_at, pinned_updated_at_ms, updated_at)
       VALUES (?, ?, CASE WHEN ? THEN datetime('now') ELSE NULL END, ?, datetime('now'))
       ON CONFLICT(user_id, conv_id) DO UPDATE SET
         pinned_at = CASE WHEN ? THEN datetime('now') ELSE NULL END,
         pinned_updated_at_ms = excluded.pinned_updated_at_ms, updated_at = datetime('now')
       WHERE excluded.pinned_updated_at_ms >= convs_user.pinned_updated_at_ms`,
    ).run(
      input.userId,
      convId,
      input.value ? 1 : 0,
      input.updatedAt,
      input.value ? 1 : 0,
    );
    return;
  }
  db.prepare(
    `INSERT INTO convs_user (user_id, conv_id, muted, muted_updated_at_ms, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, conv_id) DO UPDATE SET muted = excluded.muted,
       muted_updated_at_ms = excluded.muted_updated_at_ms, updated_at = datetime('now')
     WHERE excluded.muted_updated_at_ms >= convs_user.muted_updated_at_ms`,
  ).run(input.userId, convId, input.value ? 1 : 0, input.updatedAt);
}

function getBooleanState(
  db: Database,
  input: { userId: string; type: "group" | "dm"; id: string },
  field: "pinned" | "muted",
): ConversationMutedState {
  const valueExpr = field === "pinned" ? "(pinned_at IS NOT NULL)" : "muted";
  const timestamp =
    field === "pinned" ? "pinned_updated_at_ms" : "muted_updated_at_ms";
  const row = db
    .prepare(
      `SELECT ${valueExpr} AS value, ${timestamp} AS updatedAt FROM convs_user WHERE user_id = ? AND conv_id = ?`,
    )
    .get(input.userId, refConvId(input)) as
    { value: number; updatedAt: number } | undefined;
  return row
    ? { value: !!row.value, updatedAt: row.updatedAt }
    : { value: false, updatedAt: 0 };
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
  setBooleanState(db, { ...input, value: input.pinned }, "pinned");
}
export function getConversationPinnedState(
  db: Database,
  input: { userId: string; type: "group" | "dm"; id: string },
): ConversationMutedState {
  return getBooleanState(db, input, "pinned");
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
  setBooleanState(db, { ...input, value: input.muted }, "muted");
}
export function getConversationMutedState(
  db: Database,
  input: { userId: string; type: "group" | "dm"; id: string },
): ConversationMutedState {
  return getBooleanState(db, input, "muted");
}

export function getConversationComposeDraftValue(
  db: Database,
  input: { userId: string; type: "group" | "dm"; id: string },
): { draft: string; updatedAt: number } {
  const row = db
    .prepare(
      "SELECT compose_draft, compose_draft_updated_at FROM convs_user WHERE user_id = ? AND conv_id = ?",
    )
    .get(input.userId, refConvId(input)) as
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
    `UPDATE convs_user SET compose_draft = NULL, compose_draft_updated_at = ?, updated_at = datetime('now')
     WHERE user_id = ? AND conv_id = ? AND compose_draft_updated_at <= ?`,
  ).run(input.updatedAt, input.userId, refConvId(input), input.updatedAt);
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
    `INSERT INTO convs_user (user_id, conv_id, compose_draft, compose_draft_updated_at, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, conv_id) DO UPDATE SET compose_draft = excluded.compose_draft,
       compose_draft_updated_at = excluded.compose_draft_updated_at, updated_at = datetime('now')
     WHERE excluded.compose_draft_updated_at >= convs_user.compose_draft_updated_at`,
  ).run(input.userId, refConvId(input), input.draft, input.updatedAt);
}

export function purgeConversationStateForUser(
  db: Database,
  userId: string,
): void {
  db.prepare("DELETE FROM convs_user WHERE user_id = ?").run(userId);
}
