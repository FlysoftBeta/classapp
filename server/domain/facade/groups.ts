import type {
  CreateGroupInput,
  DiscoverySection,
  GroupMembersResult,
  GroupService,
  JoinGroupResult,
  UpdateGroupInput,
} from "@/server/services/groupsService";
import type { AdminGroup, Group } from "@/shared/types/api";
import type { Actor } from "@/server/runtime/actor";
import type { AuditService } from "@/server/services/auditService";
import type { AccessService } from "@/server/services/accessService";

export class GroupActorFacade {
  constructor(
    private readonly actor: Actor,
    private readonly groups: GroupService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
  ) {}

  async create(input: CreateGroupInput): Promise<Group> {
    const user = await this.actor.requireUser();
    return this.groups.create(input, user.id);
  }

  async discoverSections(query = ""): Promise<DiscoverySection[]> {
    const user = await this.actor.requireUser();
    return this.groups.discoverSections(user.id, query);
  }

  async discoverSubgroups(groupKey: string, query = ""): Promise<Group[]> {
    const user = await this.actor.requireUser();
    return this.groups.discoverSubgroups(user.id, groupKey, query);
  }

  async join(
    groupKey: string,
    source: { type: "search" } | { type: "group"; groupId: string },
    password?: string,
  ): Promise<JoinGroupResult> {
    const user = await this.actor.requireUser();
    const result = this.groups.join(user.id, groupKey, source, password);
    if (result.ok) this.access.onGroupMembershipChanged(user.id, result.group.id);
    return result;
  }

  async leave(groupKey: string): Promise<void> {
    const user = await this.actor.requireUser();
    const { group, deleted } = this.groups.leave(user.id, groupKey);
    this.access.onGroupMembershipChanged(user.id, group.id, deleted);
  }

  async members(groupKey: string): Promise<GroupMembersResult> {
    const user = await this.actor.requireUser();
    return this.groups.members(
      groupKey,
      user.id,
      this.actor.hasRole("community_manager"),
    );
  }

  async setSelfHidden(groupKey: string, hideSelf: boolean): Promise<void> {
    const user = await this.actor.requireUser();
    this.groups.setSelfHidden(user.id, groupKey, hideSelf);
  }

  async adminList(
    offset: number,
  ): Promise<{ groups: AdminGroup[]; total: number }> {
    this.actor.requireRole("community_manager");
    return this.groups.adminList(offset);
  }

  adminCreate(input: CreateGroupInput): Group {
    const admin = this.actor.requireRole("community_manager");
    const group = this.groups.adminCreate(input);
    this.audit.record({
      actorId: admin.id,
      action: "group.create",
      targetKind: "group",
      targetId: group.id,
    });
    return group;
  }

  adminUpdate(groupId: string, input: UpdateGroupInput): Group {
    const admin = this.actor.requireRole("advanced_community_manager");
    const group = this.groups.adminUpdate(groupId, input);
    this.audit.record({
      actorId: admin.id,
      action: "group.update",
      targetKind: "group",
      targetId: groupId,
      details: { fields: Object.keys(input) },
    });
    return group;
  }

  adminDelete(groupId: string): void {
    const admin = this.actor.requireRole("advanced_community_manager");
    this.access.onGroupDeleted(groupId);
    this.groups.adminDelete(groupId);
    this.audit.record({
      actorId: admin.id,
      action: "group.delete",
      targetKind: "group",
      targetId: groupId,
    });
  }

  adminAddMember(groupId: string, userId: string): void {
    const admin = this.actor.requireRole("advanced_community_manager");
    this.groups.adminAddMember(groupId, userId);
    this.access.onGroupMembershipChanged(userId, groupId);
    this.audit.record({
      actorId: admin.id,
      action: "group.member.add",
      targetKind: "group",
      targetId: groupId,
      details: { user_id: userId },
    });
  }

  adminRemoveMember(groupId: string, userId: string): void {
    const admin = this.actor.requireRole("advanced_community_manager");
    const deleted = this.groups.adminRemoveMember(groupId, userId);
    this.access.onGroupMembershipChanged(userId, groupId, deleted);
    this.audit.record({
      actorId: admin.id,
      action: "group.member.remove",
      targetKind: "group",
      targetId: groupId,
      details: { user_id: userId },
    });
  }

  isGroupAdminOnly(groupId: string): boolean {
    return this.groups.isGroupAdminOnly(groupId);
  }
}
