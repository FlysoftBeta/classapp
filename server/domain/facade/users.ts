import type { Actor } from "@/server/runtime/actor";
import {
  type CreateUserParams,
  type ResetPinParams,
  type UpdateSelfProfileParams,
  type UpdateUserParams,
  type UserService,
  type UserRemovalMode,
} from "@/server/services/usersService";
import type { RoleService } from "@/server/services/roleService";
import type { AdminRole } from "@/shared/authority";
import type { GroupService } from "@/server/services/groupsService";
import type { ConversationService } from "@/server/services/conversationsService";
import type { PostService } from "@/server/services/postsService";
import type { ArticleService } from "@/server/services/articlesService";
import type { WordsService } from "@/server/services/wordsService";
import type { ClientService } from "@/server/services/clientsService";
import type { UserConfigService } from "@/server/services/userConfig";
import type { AiService } from "@/server/services/ai/aiService";
import type { AiBillingService } from "@/server/services/ai/aiBillingService";
import { PublicError } from "@/server/services/incidentService";
import type { AuditService } from "@/server/services/auditService";
import type { AccessService } from "@/server/services/accessService";
import type { UnitOfWork } from "@/server/runtime/unitOfWork";

export class UserActorFacade {
  constructor(
    private readonly actor: Actor,
    private readonly users: UserService,
    private readonly roles: RoleService,
    private readonly groups: GroupService,
    private readonly conversations: ConversationService,
    private readonly posts: PostService,
    private readonly articles: ArticleService,
    private readonly words: WordsService,
    private readonly clients: ClientService,
    private readonly userConfig: UserConfigService,
    private readonly ai: AiService,
    private readonly aiBilling: AiBillingService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  async list(input: { q?: string; offset?: number }) {
    this.requireUserDirectoryAccess();
    return this.users.list(input.q ?? "", input.offset ?? 0);
  }

  async create(input: CreateUserParams) {
    const admin = this.actor.requireRole("access_manager");
    if (input.features !== undefined) {
      this.actor.requireRole("feature_manager");
    }
    return this.unitOfWork.run(() => {
      const user = this.users.create(input);
      this.audit.record({
        actorId: admin.id,
        action: "user.create",
        targetKind: "user",
        targetId: user.id,
      });
      return user;
    });
  }

  async update(
    input: UpdateUserParams & {
      userId: string;
      mute_hours?: number;
      unmute?: boolean;
      ban_hours?: number;
      unban?: boolean;
      roles?: AdminRole[];
    },
  ) {
    return this.unitOfWork.run(() => {
      const actor = this.actor.requireUser();
      if (
        input.unmute === true ||
        input.mute_hours !== undefined ||
        input.unban === true ||
        input.ban_hours !== undefined ||
        input.pin !== undefined
      ) {
        this.actor.requireRole("community_manager");
      }
      if (input.handle !== undefined || input.username !== undefined) {
        this.actor.requireRole("advanced_community_manager");
      }
      if (input.features !== undefined) {
        this.actor.requireRole("feature_manager");
      }
      if (input.roles !== undefined) {
        const root = this.actor.requireRole("root");
        this.roles.replace(input.userId, input.roles, root.id);
      }
      if (input.unmute === true) {
        this.users.unmute(input.userId);
      } else if (input.mute_hours !== undefined) {
        this.users.mute(input.userId, input.mute_hours);
      }

      if (input.unban === true) {
        this.users.unban(input.userId);
      } else if (input.ban_hours !== undefined) {
        this.users.ban(input.userId, input.ban_hours);
      }

      const profileBody = {
        handle: input.handle,
        username: input.username,
        features: input.features,
        pin: input.pin,
      };
      const hasProfileUpdate = Object.values(profileBody).some(
        (value) => value !== undefined,
      );
      if (hasProfileUpdate) {
        const user = this.users.update(input.userId, profileBody);
        this.audit.record({
          actorId: actor.id,
          action: "user.update",
          targetKind: "user",
          targetId: input.userId,
          details: {
            fields: Object.entries(input)
              .filter(([key, value]) => key !== "pin" && value !== undefined)
              .map(([key]) => key),
          },
        });
        return user;
      }
      const user = this.users.get(input.userId);
      this.audit.record({
        actorId: actor.id,
        action: "user.update",
        targetKind: "user",
        targetId: input.userId,
        details: {
          fields: Object.entries(input)
            .filter(([key, value]) => key !== "pin" && value !== undefined)
            .map(([key]) => key),
        },
      });
      return user;
    });
  }

  async remove(userId: string, mode: UserRemovalMode): Promise<void> {
    const admin = this.actor.requireRole("advanced_community_manager");
    this.roles.assertRemovable(userId);
    if (userId === admin.id) throw new PublicError("不能删除自己");
    if (mode === "deactivate") {
      for (const change of this.groups.removeUserFromAllGroups(userId)) {
        this.access.onGroupMembershipChanged(
          userId,
          change.groupId,
          change.deleted,
        );
      }
      this.users.deactivate(userId);
      this.audit.record({
        actorId: admin.id,
        action: "user.deactivate",
        targetKind: "user",
        targetId: userId,
      });
      return;
    }

    // Each mechanism removes its own state; the identity row is deleted last.
    for (const change of this.groups.purgeUser(userId)) {
      this.access.onGroupMembershipChanged(
        userId,
        change.groupId,
        change.deleted,
      );
    }
    this.conversations.purgeUser(userId);
    this.posts.purgeUser(userId);
    await this.articles.purgeUser(userId);
    this.words.purgeUser(userId);
    this.clients.purgeUser(userId);
    this.userConfig.purgeUser(userId);
    await this.ai.purgeUser(userId);
    this.aiBilling.purgeUser(userId);
    this.access.onUserPurged(userId);
    this.users.purgeIdentity(userId);
    this.audit.record({
      actorId: admin.id,
      action: "user.purge",
      targetKind: "user",
      targetId: userId,
    });
  }

  async updateSelf(input: UpdateSelfProfileParams) {
    const user = await this.actor.requireUser();
    return this.users.updateSelfProfile(user.id, input);
  }

  async resetSelfPin(input: ResetPinParams): Promise<void> {
    const user = await this.actor.requireUser();
    this.users.resetSelfPin(user.id, input);
  }

  private requireUserDirectoryAccess(): void {
    this.actor.requireUser();
    const canBrowseUsers =
      this.actor.hasRole("root") ||
      this.actor.hasRole("feature_manager") ||
      this.actor.hasRole("access_manager") ||
      this.actor.hasRole("community_manager");
    if (!canBrowseUsers) throw new PublicError("无权限");
  }
}
