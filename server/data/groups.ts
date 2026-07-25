import type { Database } from "better-sqlite3";
import type { AdminGroup, GroupMember } from "@/shared/types/api";
import type { Group } from "@/shared/types/api";

const GROUP_SELECT = `
  SELECT id, handle, name, (password_hash IS NOT NULL) as has_password,
         type, members_hidden, admin_only, no_leave, parent_group_id, created_at
  FROM groups
`;

const GROUP_LIST_SELECT = `
  id, handle, name, (password_hash IS NOT NULL) as has_password,
  type, members_hidden, admin_only, no_leave, parent_group_id, created_at
`;

export interface DiscoveryParentRow {
  id: string;
  name: string;
}

export interface GroupMemberVisibilityRow {
  members_hidden: number;
  no_leave: number;
}

export interface GroupMembershipRow {
  hide_self: number;
}

export interface GroupJoinRow {
  id: string;
  password_hash: string | null;
}

export interface GroupTypeRow {
  id: string;
  type: string;
}

export interface GroupAdminOnlyRow {
  admin_only: number;
}

export interface GroupInsertRow {
  id: string;
  handle: string;
  name: string;
  discoverable: number;
  password_hash: string | null;
  type: string;
  members_hidden: number;
  admin_only: number;
  no_leave: number;
  parent_group_id: string | null;
}

export interface GroupUpdateFields {
  handle?: string;
  name?: string;
  discoverable?: number;
  password_hash?: string | null;
  members_hidden?: number;
  admin_only?: number;
  no_leave?: number;
  parent_group_id?: string | null;
  type?: string;
}

export function findGroupById(db: Database, id: string): Group | null {
  return (
    (db.prepare(`${GROUP_SELECT} WHERE id = ?`).get(id) as Group | undefined) ??
    null
  );
}

export function findGroupByHandle(db: Database, handle: string): Group | null {
  return (
    (db.prepare(`${GROUP_SELECT} WHERE handle = ?`).get(handle) as
      Group | undefined) ?? null
  );
}

export function findGroupByIdOrHandle(db: Database, key: string): Group | null {
  return findGroupById(db, key) ?? findGroupByHandle(db, key);
}

export function findGroupType(db: Database, id: string): GroupTypeRow | null {
  return (
    (db.prepare("SELECT id, type FROM groups WHERE id = ?").get(id) as
      GroupTypeRow | undefined) ?? null
  );
}

export function findGroupJoinInfo(
  db: Database,
  id: string,
): GroupJoinRow | null {
  return (
    (db.prepare("SELECT id, password_hash FROM groups WHERE id = ?").get(id) as
      GroupJoinRow | undefined) ?? null
  );
}

export function findGroupMemberVisibility(
  db: Database,
  id: string,
): GroupMemberVisibilityRow | null {
  return (
    (db
      .prepare("SELECT members_hidden, no_leave FROM groups WHERE id = ?")
      .get(id) as GroupMemberVisibilityRow | undefined) ?? null
  );
}

export function findGroupLeavePolicy(
  db: Database,
  id: string,
): { no_leave: number } | null {
  return (
    (db.prepare("SELECT no_leave FROM groups WHERE id = ?").get(id) as
      { no_leave: number } | undefined) ?? null
  );
}

export function findGroupAdminOnly(
  db: Database,
  id: string,
): GroupAdminOnlyRow | null {
  return (
    (db.prepare("SELECT admin_only FROM groups WHERE id = ?").get(id) as
      GroupAdminOnlyRow | undefined) ?? null
  );
}

export function groupHandleExists(
  db: Database,
  handle: string,
  exceptId?: string,
): boolean {
  const row = exceptId
    ? db
        .prepare("SELECT id FROM groups WHERE handle = ? AND id != ?")
        .get(handle, exceptId)
    : db.prepare("SELECT id FROM groups WHERE handle = ?").get(handle);
  return !!row;
}

export function listDiscoveryParents(
  db: Database,
  userId: string,
): DiscoveryParentRow[] {
  return db
    .prepare(
      `SELECT g.id, g.name
       FROM user_groups ug
       JOIN groups g ON g.id = ug.group_id
       WHERE ug.user_id = ?
       ORDER BY CASE WHEN g.type = 'wild' THEN 0 ELSE 1 END, g.name`,
    )
    .all(userId) as DiscoveryParentRow[];
}

export function listLinkedGroups(
  db: Database,
  parentGroupId: string,
  userId: string,
  q: string,
): Group[] {
  if (!q.trim()) {
    return db
      .prepare(
        `SELECT ${GROUP_LIST_SELECT}
         FROM groups g
         WHERE g.parent_group_id = ?
           AND g.id NOT IN (SELECT group_id FROM user_groups WHERE user_id = ?)
         ORDER BY g.name`,
      )
      .all(parentGroupId, userId) as Group[];
  }

  return db
    .prepare(
      `SELECT ${GROUP_LIST_SELECT}
       FROM groups g
       WHERE g.parent_group_id = ?
         AND g.id NOT IN (SELECT group_id FROM user_groups WHERE user_id = ?)
         AND (g.id LIKE ? OR g.name LIKE ?)
       ORDER BY g.name
       LIMIT 30`,
    )
    .all(parentGroupId, userId, `%${q}%`, `%${q}%`) as Group[];
}

export function listAllGroups(
  db: Database,
  offset: number,
): { groups: AdminGroup[]; total: number } {
  const groups = db
    .prepare(
      `SELECT g.id, g.handle, g.name,
              (g.password_hash IS NOT NULL) as has_password,
              g.type, g.discoverable, g.members_hidden, g.admin_only, g.no_leave,
              g.parent_group_id, g.created_at,
              COUNT(ug.user_id) as member_count
       FROM groups g
       LEFT JOIN user_groups ug ON g.id = ug.group_id
       GROUP BY g.id
       ORDER BY g.created_at DESC
       LIMIT 50 OFFSET ?`,
    )
    .all(offset) as AdminGroup[];
  const total = (
    db.prepare("SELECT COUNT(*) as n FROM groups").get() as { n: number }
  ).n;
  return { groups, total };
}

export function listGroupMemberIds(db: Database, groupId: string): string[] {
  return (
    db
      .prepare("SELECT user_id FROM user_groups WHERE group_id = ?")
      .all(groupId) as { user_id: string }[]
  ).map((row) => row.user_id);
}

export function listGroupMembersForView(
  db: Database,
  groupId: string,
  viewerUserId: string,
  isAdmin: boolean,
): GroupMember[] {
  return isAdmin
    ? (db
        .prepare(
          `SELECT u.id, u.handle, u.username, u.created_at, ug.joined_at, ug.hide_self
           FROM user_groups ug
           JOIN users u ON ug.user_id = u.id
           WHERE ug.group_id = ?
           ORDER BY ug.joined_at ASC`,
        )
        .all(groupId) as GroupMember[])
    : (db
        .prepare(
          `SELECT u.id, u.handle, u.username, u.created_at, ug.joined_at, ug.hide_self
           FROM user_groups ug
           JOIN users u ON ug.user_id = u.id
           WHERE ug.group_id = ?
             AND (ug.hide_self = 0 OR ug.user_id = ?)
           ORDER BY ug.joined_at ASC`,
        )
        .all(groupId, viewerUserId) as GroupMember[]);
}

export function findMembership(
  db: Database,
  userId: string,
  groupId: string,
): GroupMembershipRow | null {
  return (
    (db
      .prepare(
        "SELECT hide_self FROM user_groups WHERE user_id = ? AND group_id = ?",
      )
      .get(userId, groupId) as GroupMembershipRow | undefined) ?? null
  );
}

export function isGroupMember(
  db: Database,
  userId: string,
  groupId: string,
): boolean {
  return !!db
    .prepare("SELECT 1 FROM user_groups WHERE user_id = ? AND group_id = ?")
    .get(userId, groupId);
}

export function userExists(db: Database, userId: string): boolean {
  return !!db.prepare("SELECT id FROM users WHERE id = ?").get(userId);
}

export function insertGroup(db: Database, row: GroupInsertRow): void {
  db.prepare(
    `INSERT INTO groups (
      id, handle, name, discoverable, password_hash, type,
      members_hidden, admin_only, no_leave, parent_group_id
    ) VALUES (
      @id, @handle, @name, @discoverable, @password_hash, @type,
      @members_hidden, @admin_only, @no_leave, @parent_group_id
    )`,
  ).run(row);
}

export function updateGroupFields(
  db: Database,
  id: string,
  fields: GroupUpdateFields,
): void {
  const entries = Object.entries(fields).filter(
    ([, value]) => value !== undefined,
  );
  if (entries.length === 0) return;
  const assignments = entries.map(([key]) => `${key} = @${key}`).join(", ");
  db.prepare(`UPDATE groups SET ${assignments} WHERE id = @id`).run({
    id,
    ...fields,
  });
}

export function deleteGroupById(db: Database, id: string): void {
  db.prepare("DELETE FROM groups WHERE id = ?").run(id);
}

export function addGroupMember(
  db: Database,
  userId: string,
  groupId: string,
): void {
  db.prepare(
    "INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)",
  ).run(userId, groupId);
}

export function removeGroupMember(
  db: Database,
  userId: string,
  groupId: string,
): void {
  db.prepare("DELETE FROM user_groups WHERE user_id = ? AND group_id = ?").run(
    userId,
    groupId,
  );
}

export function updateMembershipHideSelf(
  db: Database,
  groupId: string,
  userId: string,
  hideSelf: boolean,
): void {
  db.prepare(
    "UPDATE user_groups SET hide_self = ? WHERE user_id = ? AND group_id = ?",
  ).run(hideSelf ? 1 : 0, userId, groupId);
}

export function demoteGroupsByType(
  db: Database,
  type: string,
  exceptId?: string,
): void {
  if (exceptId) {
    db.prepare(
      "UPDATE groups SET type = 'normal' WHERE type = ? AND id != ?",
    ).run(type, exceptId);
    return;
  }
  db.prepare("UPDATE groups SET type = 'normal' WHERE type = ?").run(type);
}
