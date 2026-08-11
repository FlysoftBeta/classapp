import type {
  CreateGroupInput,
  DiscoverySection,
  GroupMembersResult,
  GroupService,
  JoinGroupResult,
  UpdateGroupInput,
} from "@/server/services/groupsService";
import type { AdminGroup, Group } from "@/shared/types/api";
import type { Actor } from "@/server/session/session";
import { hasFeature } from "@/shared/features";
export class GroupActorFacade {
  constructor(
    private readonly actor: Actor,
    private readonly groups: GroupService,
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
    return this.groups.join(user.id, groupKey, source, password);
  }

  async leave(groupKey: string): Promise<void> {
    const user = await this.actor.requireUser();
    this.groups.leave(user.id, groupKey);
  }

  async members(groupKey: string): Promise<GroupMembersResult> {
    const user = await this.actor.requireUser();
    return this.groups.members(
      groupKey,
      user.id,
      hasFeature(this.actor.user, "admin"),
    );
  }

  async setSelfHidden(groupKey: string, hideSelf: boolean): Promise<void> {
    const user = await this.actor.requireUser();
    this.groups.setSelfHidden(user.id, groupKey, hideSelf);
  }

  async adminList(
    offset: number,
  ): Promise<{ groups: AdminGroup[]; total: number }> {
    await this.actor.requireAdmin();
    return this.groups.adminList(offset);
  }

  async adminCreate(input: CreateGroupInput): Promise<Group> {
    await this.actor.requireAdmin();
    return this.groups.adminCreate(input);
  }

  async adminUpdate(groupId: string, input: UpdateGroupInput): Promise<Group> {
    await this.actor.requireAdmin();
    return this.groups.adminUpdate(groupId, input);
  }

  async adminDelete(groupId: string): Promise<void> {
    await this.actor.requireAdmin();
    this.groups.adminDelete(groupId);
  }

  async adminAddMember(groupId: string, userId: string): Promise<void> {
    await this.actor.requireAdmin();
    this.groups.adminAddMember(groupId, userId);
  }

  async adminRemoveMember(groupId: string, userId: string): Promise<void> {
    await this.actor.requireAdmin();
    this.groups.adminRemoveMember(groupId, userId);
  }

  isGroupAdminOnly(groupId: string): boolean {
    return this.groups.isGroupAdminOnly(groupId);
  }
}
