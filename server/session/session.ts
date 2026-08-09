import { getUserFromToken } from "@/server/infra/auth";
import { getDb } from "@/server/infra/db";
import { getClientIdFromToken } from "@/server/data/clients";
import type { User } from "@/shared/types/api";
import { CheckedError } from "@/shared/protocol/errors";
import { requestContext } from "@/server/session/requestContext";
import { hasFeature, type FeatureGate } from "@/shared/features";

export class Session {
  private userPromise?: Promise<User | null>;
  private clientIdPromise?: Promise<string | null>;

  constructor(private readonly token: string | null) {}

  static fromToken(token: string | null | undefined): Session {
    return new Session(token?.trim() || null);
  }

  static async fromActionContext(): Promise<Session> {
    return Session.fromToken(requestContext().token);
  }

  tokenValue(): string | null {
    return this.token;
  }

  async user(): Promise<User | null> {
    if (!this.userPromise) {
      this.userPromise = Promise.resolve(
        this.token ? getUserFromToken(this.token) : null,
      );
    }
    return this.userPromise;
  }

  async requireUser(): Promise<User> {
    const user = await this.user();
    if (!user) {
      throw new CheckedError("SESSION_EXPIRED", "会话已过期", 401, true);
    }
    return user;
  }

  async identity(): Promise<string | null> {
    const user = await this.user();
    return user?.id ?? null;
  }

  async clientId(): Promise<string | null> {
    if (!this.clientIdPromise) {
      this.clientIdPromise = Promise.resolve(
        this.token ? (getClientIdFromToken(getDb(), this.token) ?? null) : null,
      );
    }
    return this.clientIdPromise;
  }

  async asActor(): Promise<Actor> {
    return Actor.fromSession(this);
  }
}

export class Actor {
  private constructor(
    private readonly session: Session,
    readonly user: User | null,
  ) {}

  static async fromSession(session: Session): Promise<Actor> {
    return new Actor(session, await session.user());
  }

  async requireUser(): Promise<User> {
    return this.session.requireUser();
  }

  async requireAdmin(): Promise<User> {
    return this.requireFeature("admin");
  }

  async requireFeature(gate: FeatureGate): Promise<User> {
    const user = await this.requireUser();
    if (!hasFeature(user, gate)) {
      throw new CheckedError("FORBIDDEN", "无权限", 403);
    }
    return user;
  }

  async clientId(): Promise<string | null> {
    return this.session.clientId();
  }

  async groups() {
    const [{ GroupActorFacade }, { createGroupService }] = await Promise.all([
      import("@/server/domain/facade/groups"),
      import("@/server/services/groupsService"),
    ]);
    return new GroupActorFacade(this, createGroupService(getDb()));
  }

  async articles() {
    const [
      { ArticleActorFacade },
      { createArticleService },
      { createArticleImportService },
    ] = await Promise.all([
      import("@/server/domain/facade/articles"),
      import("@/server/services/articlesService"),
      import("@/server/services/articleImportService"),
    ]);
    return new ArticleActorFacade(
      this,
      createArticleService(getDb()),
      createArticleImportService(getDb()),
    );
  }

  async conversations() {
    const [{ ConversationActorFacade }, { createConversationService }] =
      await Promise.all([
        import("@/server/domain/facade/conversations"),
        import("@/server/services/conversationsService"),
      ]);
    return new ConversationActorFacade(
      this,
      createConversationService(getDb()),
    );
  }

  async versionedUserConfig() {
    const [{ VersionedUserConfigActorFacade }, { VersionedUserConfigService }] =
      await Promise.all([
        import("@/server/domain/facade/versionedUserConfig"),
        import("@/server/services/versionedUserConfigService"),
      ]);
    return new VersionedUserConfigActorFacade(
      this,
      new VersionedUserConfigService(getDb()),
    );
  }

  async notificationConfig() {
    const [
      { NotificationConfigActorFacade },
      { createNotificationConfigService },
    ] = await Promise.all([
      import("@/server/domain/facade/notificationConfig"),
      import("@/server/services/notificationConfigService"),
    ]);
    return new NotificationConfigActorFacade(
      this,
      createNotificationConfigService(getDb()),
    );
  }

  async announcement() {
    const [{ AnnouncementActorFacade }, { createAnnouncementService }] =
      await Promise.all([
        import("@/server/domain/facade/announcement"),
        import("@/server/services/announcementService"),
      ]);
    return new AnnouncementActorFacade(
      this,
      createAnnouncementService(getDb()),
    );
  }

  async stickers() {
    const [{ StickerActorFacade }, { createStickerService }] =
      await Promise.all([
        import("@/server/domain/facade/stickers"),
        import("@/server/services/stickerService"),
      ]);
    return new StickerActorFacade(this, createStickerService(getDb()));
  }

  async posts() {
    const [{ PostActorFacade }, { createPostService }] = await Promise.all([
      import("@/server/domain/facade/posts"),
      import("@/server/services/postsService"),
    ]);
    return new PostActorFacade(this, createPostService(getDb()));
  }

  async users() {
    const [{ UserActorFacade }, { createUserService }] = await Promise.all([
      import("@/server/domain/facade/users"),
      import("@/server/services/usersService"),
    ]);
    return new UserActorFacade(this, createUserService(getDb()));
  }

  async ghostUsers() {
    const [{ GhostUserActorFacade }, { createGhostUserService }] =
      await Promise.all([
        import("@/server/domain/facade/ghostUsers"),
        import("@/server/services/ghostUsersService"),
      ]);
    return new GhostUserActorFacade(this, createGhostUserService(getDb()));
  }

  async words() {
    const [{ WordsActorFacade }, { createWordsService }] = await Promise.all([
      import("@/server/domain/facade/words"),
      import("@/server/services/wordsService"),
    ]);
    return new WordsActorFacade(this, createWordsService(getDb()));
  }
}

export function resolveBearerToken(value: string | null): string | null {
  if (!value || !value.startsWith("Bearer ")) return null;
  return value.slice(7).trim();
}

export async function actionRequestIp(): Promise<string> {
  return requestContext().ip;
}

export function actionClientIdentity() {
  const { ip, userAgent, mac } = requestContext();
  return { ip, userAgent, mac };
}
