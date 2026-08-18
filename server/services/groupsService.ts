import crypto from "crypto";
import type { Database } from "better-sqlite3";
import {
  addGroupMember,
  deleteGroupById,
  demoteGroupsByType,
  findGroupAdminOnly,
  findGroupById,
  findGroupByIdOrHandle,
  findGroupJoinInfo,
  findGroupLeavePolicy,
  findGroupMemberVisibility,
  findGroupType,
  findMembership,
  groupHandleExists,
  insertGroup,
  isGroupMember,
  listAllGroups,
  listDiscoveryParents,
  listGroupMemberIds,
  listGroupMembersForView,
  listLinkedGroups,
  listUserGroupIds,
  removeGroupMember,
  updateGroupFields,
  updateMembershipHideSelf,
  userExists,
} from "@/server/data/groups";
import {
  ContractViolationError,
  PublicError,
} from "@/server/services/incidentService";
import { publishConversationUpdate } from "@/server/services/conversationsService";
import { publishRemoteResubscribe } from "@/server/services/eventBus";
import type { AdminGroup, Group, GroupMember } from "@/shared/types/api";
import { groupConvId } from "@/shared/conversations/id";
import { userMetadataForIds } from "@/server/data/users";
import type { UserMetadata } from "@/shared/types/api";

const HANDLE_RE = /^[a-zA-Z0-9_-]{1,32}$/;

function isSpecialType(type: string): boolean {
  return type === "wild" || type === "announcement";
}

function hashPassword(password: string): string {
  return crypto.createHash("sha256").update(password).digest("hex");
}

function requireTrimmed(value: string, message: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ContractViolationError(message);
  }
  return trimmed;
}

function ensureHandleFormat(handle: string): string {
  const trimmed = handle.trim();
  if (!HANDLE_RE.test(trimmed)) {
    throw new ContractViolationError(
      "Handle must contain only letters, numbers, underscores, or hyphens and be 1-32 characters long",
    );
  }
  return trimmed;
}

export interface DiscoverySection {
  parent: { id: string; name: string };
  groups: Group[];
}

export interface CreateGroupInput {
  handle?: string;
  name?: string;
  password?: string;
  type?: string;
  discoverable?: boolean;
  members_hidden?: boolean;
  admin_only?: boolean;
  no_leave?: boolean;
  parent_group_id?: string | null;
}

export interface UpdateGroupInput extends CreateGroupInput {
  clearPassword?: boolean;
}

export interface GroupMembersResult {
  members: GroupMember[];
  users: UserMetadata[];
  hidden: boolean;
  no_leave: boolean;
  self_hide_self: boolean;
}

export type JoinGroupResult =
  | { ok: true; group: Group }
  | { ok: false; error: string; needs_password: boolean };

export class GroupService {
  constructor(private readonly db: Database) {}

  isMember(userId: string, groupId: string): boolean {
    return isGroupMember(this.db, userId, groupId);
  }

  private ensureUniqueHandle(handle: string, exceptId?: string): void {
    if (groupHandleExists(this.db, handle, exceptId)) {
      throw new PublicError("该 handle 已被占用");
    }
  }

  private generateUniqueHandle(name: string): string {
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 24) || "group";
    for (let i = 0; i < 8; i += 1) {
      const candidate = i === 0 ? base : `${base}-${i}`;
      if (!groupHandleExists(this.db, candidate) && HANDLE_RE.test(candidate)) {
        return candidate;
      }
    }
    return `g-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
  }

  private requireGroup(groupKey: string): Group {
    const group = findGroupByIdOrHandle(this.db, groupKey);
    if (!group) {
      throw new PublicError("群组不存在");
    }
    return group;
  }

  private resolveParentGroupId(
    parentGroupId: string | null | undefined,
    isAdmin: boolean,
    creatorId?: string,
  ): string | null {
    if (!parentGroupId) return null;
    const parent = findGroupById(this.db, parentGroupId);
    if (!parent) {
      throw new PublicError("父群组不存在");
    }
    if (
      creatorId &&
      !isAdmin &&
      !isGroupMember(this.db, creatorId, parentGroupId)
    ) {
      throw new PublicError("你不在所选父群组中");
    }
    return parentGroupId;
  }

  private tryDeleteEmptyGroup(groupId: string): void {
    const group = findGroupType(this.db, groupId);
    if (!group || isSpecialType(group.type)) {
      return;
    }
    if (listGroupMemberIds(this.db, groupId).length === 0) {
      deleteGroupById(this.db, groupId);
    }
  }

  /** Remove an identity from every group, bypassing normal no-leave policy. */
  removeUserFromAllGroups(userId: string): void {
    for (const groupId of listUserGroupIds(this.db, userId)) {
      removeGroupMember(this.db, userId, groupId);
      publishConversationUpdate(this.db, userId, {
        type: "group",
        id: groupId,
        removed: true,
      });
      this.tryDeleteEmptyGroup(groupId);
    }
    publishRemoteResubscribe(userId, "membership");
  }

  purgeUser(userId: string): void {
    this.removeUserFromAllGroups(userId);
  }

  private createInternal(
    input: CreateGroupInput,
    options: { creatorId?: string; isAdmin: boolean },
  ): Group {
    const name = requireTrimmed(input.name ?? "", "群组名称不能为空");
    const handle = input.handle
      ? ensureHandleFormat(input.handle)
      : this.generateUniqueHandle(name);
    this.ensureUniqueHandle(handle);

    const groupId = crypto.randomUUID();
    const groupType = input.type ?? "normal";
    const parentGroupId = input.discoverable
      ? this.resolveParentGroupId(
          input.parent_group_id ?? null,
          options.isAdmin,
          options.creatorId,
        )
      : null;

    this.db.transaction(() => {
      if (isSpecialType(groupType)) {
        demoteGroupsByType(this.db, groupType);
      }
      insertGroup(this.db, {
        id: groupId,
        conv_id: groupConvId(groupId),
        handle,
        name,
        discoverable: input.discoverable ? 1 : 0,
        password_hash: input.password ? hashPassword(input.password) : null,
        type: groupType,
        members_hidden: input.members_hidden ? 1 : 0,
        admin_only: input.admin_only ? 1 : 0,
        no_leave: input.no_leave ? 1 : 0,
        parent_group_id: parentGroupId,
      });
      if (options.creatorId) {
        addGroupMember(this.db, options.creatorId, groupId);
      }
    })();

    if (options.creatorId) {
      publishConversationUpdate(this.db, options.creatorId, {
        type: "group",
        id: groupId,
      });
    }
    return this.requireGroup(groupId);
  }

  create(input: CreateGroupInput, creatorId: string): Group {
    return this.createInternal(input, {
      creatorId,
      isAdmin: false,
    });
  }

  discoverSections(userId: string, query = ""): DiscoverySection[] {
    const parents = listDiscoveryParents(this.db, userId);
    const sections: DiscoverySection[] = [];
    for (const parent of parents) {
      const groups = listLinkedGroups(this.db, parent.id, userId, query);
      if (groups.length > 0) {
        sections.push({ parent, groups });
      }
    }
    return sections;
  }

  discoverSubgroups(userId: string, groupKey: string, query = ""): Group[] {
    const group = this.requireGroup(groupKey);
    if (!isGroupMember(this.db, userId, group.id)) {
      throw new PublicError("你不在该群组中");
    }
    return listLinkedGroups(this.db, group.id, userId, query);
  }

  join(
    userId: string,
    groupKey: string,
    source: { type: "search" } | { type: "group"; groupId: string },
    password?: string,
  ): JoinGroupResult {
    const group = findGroupByIdOrHandle(this.db, groupKey);
    if (!group) {
      return { ok: false, error: "群组不存在", needs_password: false };
    }
    const joinInfo = findGroupJoinInfo(this.db, group.id);
    if (!joinInfo) {
      return { ok: false, error: "群组不存在", needs_password: false };
    }
    if (source.type === "search") {
      if (joinInfo.discoverable !== 1) {
        return {
          ok: false,
          error: "该群组未开启搜索加入",
          needs_password: false,
        };
      }
    } else if (
      joinInfo.parent_group_id !== source.groupId ||
      !isGroupMember(this.db, userId, source.groupId)
    ) {
      return { ok: false, error: "群组发现来源无效", needs_password: false };
    }
    if (joinInfo.password_hash) {
      if (!password) {
        return { ok: false, error: "该群组需要密码", needs_password: true };
      }
      if (hashPassword(password) !== joinInfo.password_hash) {
        return { ok: false, error: "密码错误", needs_password: true };
      }
    }
    addGroupMember(this.db, userId, group.id);
    publishConversationUpdate(this.db, userId, { type: "group", id: group.id });
    publishRemoteResubscribe(userId, "membership");
    return { ok: true, group };
  }

  leave(userId: string, groupKey: string): void {
    const group = this.requireGroup(groupKey);
    const policy = findGroupLeavePolicy(this.db, group.id);
    if (!policy) {
      throw new PublicError("群组不存在");
    }
    if (policy.no_leave === 1) {
      throw new PublicError("该群组禁止退出");
    }
    if (!isGroupMember(this.db, userId, group.id)) {
      throw new PublicError("未加入该群组");
    }
    removeGroupMember(this.db, userId, group.id);
    publishConversationUpdate(this.db, userId, {
      type: "group",
      id: group.id,
      removed: true,
    });
    publishRemoteResubscribe(userId, "membership");
    this.tryDeleteEmptyGroup(group.id);
  }

  members(
    groupKey: string,
    userId: string,
    isAdmin: boolean,
  ): GroupMembersResult {
    const group = this.requireGroup(groupKey);
    const visibility = findGroupMemberVisibility(this.db, group.id);
    if (!visibility) {
      throw new PublicError("群组不存在");
    }
    const selfMembership = findMembership(this.db, userId, group.id);
    const selfHideSelf = selfMembership?.hide_self === 1;
    if (visibility.members_hidden === 1 && !isAdmin) {
      return {
        members: [],
        users: [],
        hidden: true,
        no_leave: visibility.no_leave === 1,
        self_hide_self: selfHideSelf,
      };
    }
    if (!selfMembership && !isAdmin) {
      throw new PublicError("你不在该群组中");
    }
    const members = listGroupMembersForView(
      this.db,
      group.id,
      userId,
      isAdmin,
    );
    return {
      members,
      users: userMetadataForIds(
        this.db,
        members.map((member) => member.id),
      ),
      hidden: false,
      no_leave: visibility.no_leave === 1,
      self_hide_self: selfHideSelf,
    };
  }

  setSelfHidden(userId: string, groupKey: string, hideSelf: boolean): void {
    const group = this.requireGroup(groupKey);
    if (!findMembership(this.db, userId, group.id)) {
      throw new PublicError("未加入该群组");
    }
    updateMembershipHideSelf(this.db, group.id, userId, hideSelf);
  }

  adminList(offset: number): { groups: AdminGroup[]; total: number } {
    return listAllGroups(this.db, offset);
  }

  adminCreate(input: CreateGroupInput): Group {
    return this.createInternal(input, {
      creatorId: undefined,
      isAdmin: true,
    });
  }

  adminUpdate(groupId: string, input: UpdateGroupInput): Group {
    const group = this.requireGroup(groupId);
    const updates: Record<string, unknown> = {};

    if (input.handle !== undefined) {
      const handle = ensureHandleFormat(input.handle);
      this.ensureUniqueHandle(handle, group.id);
      updates.handle = handle;
    }
    if (input.name !== undefined) {
      updates.name = requireTrimmed(input.name, "群组名不能为空");
    }
    if (input.discoverable !== undefined) {
      updates.discoverable = input.discoverable ? 1 : 0;
    }
    if (input.clearPassword === true) {
      updates.password_hash = null;
    } else if (input.password !== undefined && input.password !== "") {
      updates.password_hash = hashPassword(input.password);
    }
    if (input.members_hidden !== undefined) {
      updates.members_hidden = input.members_hidden ? 1 : 0;
    }
    if (input.admin_only !== undefined) {
      updates.admin_only = input.admin_only ? 1 : 0;
    }
    if (input.no_leave !== undefined) {
      updates.no_leave = input.no_leave ? 1 : 0;
    }
    if (input.parent_group_id !== undefined) {
      const parentId = this.resolveParentGroupId(input.parent_group_id, true);
      if (parentId === group.id) {
        throw new ContractViolationError("群组不能关联自己");
      }
      updates.parent_group_id = parentId;
    }
    if (input.type !== undefined) {
      if (input.type === group.type) {
        // no-op
      } else if (isSpecialType(group.type)) {
        throw new PublicError("无法修改系统群组类型");
      } else {
        if (isSpecialType(input.type)) {
          demoteGroupsByType(this.db, input.type, group.id);
        }
        updates.type = input.type;
      }
    }

    updateGroupFields(this.db, group.id, updates);
    for (const memberId of listGroupMemberIds(this.db, group.id)) {
      publishConversationUpdate(this.db, memberId, {
        type: "group",
        id: group.id,
      });
    }
    return this.requireGroup(group.id);
  }

  adminDelete(groupId: string): void {
    const group = this.requireGroup(groupId);
    if (isSpecialType(group.type)) {
      throw new PublicError("无法删除系统群组");
    }
    const memberIds = listGroupMemberIds(this.db, group.id);
    deleteGroupById(this.db, group.id);
    for (const userId of memberIds) {
      publishConversationUpdate(this.db, userId, {
        type: "group",
        id: group.id,
        removed: true,
      });
      publishRemoteResubscribe(userId, "membership");
    }
  }

  adminAddMember(groupId: string, userId: string): void {
    const group = this.requireGroup(groupId);
    if (!userExists(this.db, userId)) {
      throw new PublicError("干员不存在");
    }
    addGroupMember(this.db, userId, group.id);
    publishConversationUpdate(this.db, userId, { type: "group", id: group.id });
    publishRemoteResubscribe(userId, "membership");
  }

  adminRemoveMember(groupId: string, userId: string): void {
    const group = this.requireGroup(groupId);
    removeGroupMember(this.db, userId, group.id);
    publishConversationUpdate(this.db, userId, {
      type: "group",
      id: group.id,
      removed: true,
    });
    publishRemoteResubscribe(userId, "membership");
    this.tryDeleteEmptyGroup(group.id);
  }

  isGroupAdminOnly(groupId: string): boolean {
    return findGroupAdminOnly(this.db, groupId)?.admin_only === 1;
  }
}

export function createGroupService(db: Database): GroupService {
  return new GroupService(db);
}
