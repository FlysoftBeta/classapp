import type { Database } from "better-sqlite3";
import type { Scope } from "@/server/runtime/scope";
import { scopeEntry } from "@/server/runtime/scope";
import { PostActorFacade } from "@/server/domain/facade/posts";
import { GroupActorFacade } from "@/server/domain/facade/groups";
import { UserActorFacade } from "@/server/domain/facade/users";
import { GhostUserActorFacade } from "@/server/domain/facade/ghostUsers";
import { ArticleActorFacade } from "@/server/domain/facade/articles";
import { ConversationActorFacade } from "@/server/domain/facade/conversations";
import { AiActorFacade } from "@/server/domain/facade/ai";
import { WordsActorFacade } from "@/server/domain/facade/words";
import { StickerActorFacade } from "@/server/domain/facade/stickers";
import { AnnouncementActorFacade } from "@/server/domain/facade/announcement";
import { NotificationConfigActorFacade } from "@/server/domain/facade/notificationConfig";
import { VersionedUserConfigActorFacade } from "@/server/domain/facade/versionedUserConfig";
import {
  createPostService,
  type PostService,
} from "@/server/services/postsService";
import {
  createGroupService,
  type GroupService,
} from "@/server/services/groupsService";
import {
  createUserService,
  type UserService,
} from "@/server/services/usersService";
import {
  createGhostUserService,
  type GhostUserService,
} from "@/server/services/ghostUsersService";
import {
  createArticleService,
  type ArticleService,
} from "@/server/services/articlesService";
import {
  createArticleImportService,
  type ArticleImportService,
} from "@/server/services/articleImportService";
import {
  createConversationService,
  type ConversationService,
} from "@/server/services/conversationsService";
import {
  createAiService,
  aiControllersFromSticky,
  type AiService,
} from "@/server/services/ai/aiService";
import {
  createAiBillingService,
  type AiBillingService,
} from "@/server/services/ai/aiBillingService";
import {
  createWordsService,
  type WordsService,
} from "@/server/services/wordsService";
import {
  createStickerService,
  type StickerService,
} from "@/server/services/stickerService";
import {
  createAnnouncementService,
  type AnnouncementService,
} from "@/server/services/announcementService";
import {
  createNotificationConfigService,
  type NotificationConfigService,
} from "@/server/services/notificationConfigService";
import { VersionedUserConfigService } from "@/server/services/versionedUserConfigService";
import { MediaActorFacade } from "@/server/domain/facade/media";
import { MediaService } from "@/server/services/mediaService";
import { MediaPlaylistService } from "@/server/services/mediaPlaylistService";
import { BooklistService } from "@/server/services/booklistService";
import { AccessService } from "@/server/services/accessService";
import {
  OwnerlessCapabilityService,
  type OwnerlessRecovery,
} from "@/server/services/ownerlessCapability";
import { CapabilityService } from "@/server/services/capabilityService";
import { collectionsContainingTrack } from "@/server/data/media";
import { collectionsContainingArticle } from "@/server/data/booklists";
import { getCapabilitySecret } from "@/server/infra/db";
import {
  createRoleService,
  type RoleService,
} from "@/server/services/roleService";
import {
  createClientService,
  type ClientService,
} from "@/server/services/clientsService";
import {
  createUserConfigService,
  type UserConfigService,
} from "@/server/services/userConfig";
import {
  createAuditService,
  type AuditService,
} from "@/server/services/auditService";
import { AuditActorFacade } from "@/server/domain/facade/audit";
import { AdministrationActorFacade } from "@/server/domain/facade/administration";
import { AppFacade } from "@/server/domain/facade/app";
import { AuthenticationFacade } from "@/server/domain/facade/authentication";
import { IncidentFacade } from "@/server/domain/facade/incidents";
import {
  createAppStateService,
  type AppStateService,
} from "@/server/services/appStateService";
import {
  createHttpsUpgradeService,
  type HttpsUpgradeService,
} from "@/server/services/httpsUpgradeService";
import {
  createAdminSystemService,
  type AdminSystemService,
} from "@/server/services/adminSystemService";
import {
  createTeachDocumentsService,
  type TeachDocumentsService,
} from "@/server/services/teachDocumentsService";
import {
  createIncidentService,
  type IncidentService,
} from "@/server/services/incidentService";
import {
  createAuthService,
  type AuthService,
} from "@/server/services/authService";
import { BUILD_ID } from "@/server/infra/env";
import { IncidentLogArchiveService } from "@/server/services/incidentLogArchiveService";

const postService = scopeEntry<PostService>("PostService");
const groupService = scopeEntry<GroupService>("GroupService");
const userService = scopeEntry<UserService>("UserService");
const ghostUserService = scopeEntry<GhostUserService>("GhostUserService");
const articleService = scopeEntry<ArticleService>("ArticleService");
const articleImportService = scopeEntry<ArticleImportService>(
  "ArticleImportService",
);
const conversationService = scopeEntry<ConversationService>(
  "ConversationService",
);
const aiService = scopeEntry<AiService>("AiService");
const aiBillingService = scopeEntry<AiBillingService>("AiBillingService");
const wordsService = scopeEntry<WordsService>("WordsService");
const stickerService = scopeEntry<StickerService>("StickerService");
const announcementService = scopeEntry<AnnouncementService>(
  "AnnouncementService",
);
const notificationConfigService = scopeEntry<NotificationConfigService>(
  "NotificationConfigService",
);
const versionedUserConfigService = scopeEntry<VersionedUserConfigService>(
  "VersionedUserConfigService",
);
const roleService = scopeEntry<RoleService>("RoleService");
const clientService = scopeEntry<ClientService>("ClientService");
const userConfigService = scopeEntry<UserConfigService>("UserConfigService");
const auditService = scopeEntry<AuditService>("AuditService");
const appStateService = scopeEntry<AppStateService>("AppStateService");
const httpsUpgradeService = scopeEntry<HttpsUpgradeService>(
  "HttpsUpgradeService",
);
const adminSystemService = scopeEntry<AdminSystemService>("AdminSystemService");
const teachDocumentsService = scopeEntry<TeachDocumentsService>(
  "TeachDocumentsService",
);
const incidentService = scopeEntry<IncidentService>("IncidentService");
const authService = scopeEntry<AuthService>("AuthService");
const incidentLogArchiveService = scopeEntry<IncidentLogArchiveService>(
  "IncidentLogArchiveService",
);
const mediaService = scopeEntry<MediaService>("MediaService");
const mediaPlaylistService = scopeEntry<MediaPlaylistService>(
  "MediaPlaylistService",
);
const accessService = scopeEntry<AccessService>("AccessService");
const ownerlessCapabilityService = scopeEntry<OwnerlessCapabilityService>(
  "OwnerlessCapabilityService",
);

const postFacade = scopeEntry<PostActorFacade>("PostActorFacade");
const groupFacade = scopeEntry<GroupActorFacade>("GroupActorFacade");
const userFacade = scopeEntry<UserActorFacade>("UserActorFacade");
const ghostUserFacade = scopeEntry<GhostUserActorFacade>(
  "GhostUserActorFacade",
);
const articleFacade = scopeEntry<ArticleActorFacade>("ArticleActorFacade");
const conversationFacade = scopeEntry<ConversationActorFacade>(
  "ConversationActorFacade",
);
const aiFacade = scopeEntry<AiActorFacade>("AiActorFacade");
const wordsFacade = scopeEntry<WordsActorFacade>("WordsActorFacade");
const stickerFacade = scopeEntry<StickerActorFacade>("StickerActorFacade");
const announcementFacade = scopeEntry<AnnouncementActorFacade>(
  "AnnouncementActorFacade",
);
const notificationConfigFacade = scopeEntry<NotificationConfigActorFacade>(
  "NotificationConfigActorFacade",
);
const versionedUserConfigFacade = scopeEntry<VersionedUserConfigActorFacade>(
  "VersionedUserConfigActorFacade",
);
const auditFacade = scopeEntry<AuditActorFacade>("AuditActorFacade");
const administrationFacade = scopeEntry<AdministrationActorFacade>(
  "AdministrationActorFacade",
);
const appFacade = scopeEntry<AppFacade>("AppFacade");
const authenticationFacade = scopeEntry<AuthenticationFacade>(
  "AuthenticationFacade",
);
const incidentFacade = scopeEntry<IncidentFacade>("IncidentFacade");
const mediaFacade = scopeEntry<MediaActorFacade>("MediaActorFacade");

function ownerlessRecoveryFor(db: Database): OwnerlessRecovery {
  return {
    collectionsContaining(kind, id) {
      if (kind === "track") return collectionsContainingTrack(db, id);
      if (kind === "article") return collectionsContainingArticle(db, id);
      return [];
    },
  };
}

/** Typed request composition. Every getter has Scope get-or-init semantics. */
export class Composition {
  constructor(private readonly scope: Scope) {}

  posts(): PostActorFacade {
    return this.scope.getOrInit(
      postFacade,
      () =>
        new PostActorFacade(
          this.scope.actor(),
          this.scope.getOrInit(postService, () =>
            createPostService(this.scope.db),
          ),
          this.scope.getOrInit(groupService, () =>
            createGroupService(this.scope.db),
          ),
          this.scope.getOrInit(auditService, () =>
            createAuditService(this.scope.db),
          ),
        ),
    );
  }

  groups(): GroupActorFacade {
    return this.scope.getOrInit(
      groupFacade,
      () =>
        new GroupActorFacade(
          this.scope.actor(),
          this.scope.getOrInit(groupService, () =>
            createGroupService(this.scope.db),
          ),
          this.scope.getOrInit(auditService, () =>
            createAuditService(this.scope.db),
          ),
          this.access(),
        ),
    );
  }

  users(): UserActorFacade {
    return this.scope.getOrInit(
      userFacade,
      () =>
        new UserActorFacade(
          this.scope.actor(),
          this.scope.getOrInit(userService, () =>
            createUserService(this.scope.db, this.scope.unitOfWork),
          ),
          this.scope.getOrInit(roleService, () =>
            createRoleService(this.scope.db),
          ),
          this.scope.getOrInit(groupService, () =>
            createGroupService(this.scope.db),
          ),
          this.scope.getOrInit(conversationService, () =>
            createConversationService(this.scope.db),
          ),
          this.scope.getOrInit(postService, () =>
            createPostService(this.scope.db),
          ),
          this.scope.getOrInit(articleService, () =>
            createArticleService(this.scope.db, this.scope.blobs),
          ),
          this.scope.getOrInit(wordsService, () =>
            createWordsService(this.scope.db),
          ),
          this.scope.getOrInit(clientService, () =>
            createClientService(this.scope.db),
          ),
          this.scope.getOrInit(userConfigService, () =>
            createUserConfigService(this.scope.db),
          ),
          this.scope.getOrInit(aiService, () =>
            createAiService(
              this.scope.db,
              aiControllersFromSticky(this.scope.sticky.ai),
              this.scope.getOrInit(aiBillingService, () =>
                createAiBillingService(this.scope.db),
              ),
              this.scope.blobs,
              (input) => this.scope.queueCommand({ type: "ai.execute", input }),
            ),
          ),
          this.scope.getOrInit(aiBillingService, () =>
            createAiBillingService(this.scope.db),
          ),
          this.scope.getOrInit(auditService, () =>
            createAuditService(this.scope.db),
          ),
          this.access(),
          this.scope.unitOfWork,
        ),
    );
  }

  ghostUsers(): GhostUserActorFacade {
    return this.scope.getOrInit(
      ghostUserFacade,
      () =>
        new GhostUserActorFacade(
          this.scope.actor(),
          this.scope.getOrInit(ghostUserService, () =>
            createGhostUserService(this.scope.db),
          ),
          this.scope.getOrInit(auditService, () =>
            createAuditService(this.scope.db),
          ),
        ),
    );
  }

  articles(): ArticleActorFacade {
    return this.scope.getOrInit(
      articleFacade,
      () =>
        new ArticleActorFacade(
          this.scope.actor(),
          this.scope.getOrInit(articleService, () =>
            createArticleService(this.scope.db, this.scope.blobs),
          ),
          this.scope.getOrInit(articleImportService, () =>
            createArticleImportService(this.scope.sticky.articleImports),
          ),
          this.scope.getOrInit(groupService, () =>
            createGroupService(this.scope.db),
          ),
          this.scope.getOrInit(auditService, () =>
            createAuditService(this.scope.db),
          ),
          this.access(),
          this.ownerless(),
          new BooklistService(this.scope.db, this.access(), this.ownerless()),
        ),
    );
  }

  conversations(): ConversationActorFacade {
    return this.scope.getOrInit(
      conversationFacade,
      () =>
        new ConversationActorFacade(
          this.scope.actor(),
          this.scope.getOrInit(conversationService, () =>
            createConversationService(this.scope.db),
          ),
        ),
    );
  }

  ai(): AiActorFacade {
    return this.scope.getOrInit(
      aiFacade,
      () =>
        new AiActorFacade(
          this.scope.actor(),
          this.scope.getOrInit(aiService, () =>
            createAiService(
              this.scope.db,
              aiControllersFromSticky(this.scope.sticky.ai),
              this.scope.getOrInit(aiBillingService, () =>
                createAiBillingService(this.scope.db),
              ),
              this.scope.blobs,
              (input) => this.scope.queueCommand({ type: "ai.execute", input }),
            ),
          ),
          this.scope.getOrInit(aiBillingService, () =>
            createAiBillingService(this.scope.db),
          ),
          this.scope.getOrInit(auditService, () =>
            createAuditService(this.scope.db),
          ),
          this.scope.unitOfWork,
        ),
    );
  }

  words(): WordsActorFacade {
    return this.scope.getOrInit(
      wordsFacade,
      () =>
        new WordsActorFacade(
          this.scope.actor(),
          this.scope.getOrInit(wordsService, () =>
            createWordsService(this.scope.db),
          ),
        ),
    );
  }

  stickers(): StickerActorFacade {
    return this.scope.getOrInit(
      stickerFacade,
      () =>
        new StickerActorFacade(
          this.scope.actor(),
          this.scope.getOrInit(stickerService, () =>
            createStickerService(this.scope.db),
          ),
        ),
    );
  }

  announcement(): AnnouncementActorFacade {
    return this.scope.getOrInit(
      announcementFacade,
      () =>
        new AnnouncementActorFacade(
          this.scope.actor(),
          this.scope.getOrInit(announcementService, () =>
            createAnnouncementService(this.scope.db),
          ),
        ),
    );
  }

  notificationConfig(): NotificationConfigActorFacade {
    return this.scope.getOrInit(
      notificationConfigFacade,
      () =>
        new NotificationConfigActorFacade(
          this.scope.actor(),
          this.scope.getOrInit(notificationConfigService, () =>
            createNotificationConfigService(this.scope.db),
          ),
        ),
    );
  }

  versionedUserConfig(): VersionedUserConfigActorFacade {
    return this.scope.getOrInit(
      versionedUserConfigFacade,
      () =>
        new VersionedUserConfigActorFacade(
          this.scope.actor(),
          this.scope.getOrInit(
            versionedUserConfigService,
            () => new VersionedUserConfigService(this.scope.db),
          ),
        ),
    );
  }

  audit(): AuditActorFacade {
    return this.scope.getOrInit(
      auditFacade,
      () =>
        new AuditActorFacade(
          this.scope.actor(),
          this.scope.getOrInit(auditService, () =>
            createAuditService(this.scope.db),
          ),
        ),
    );
  }

  administration(): AdministrationActorFacade {
    return this.scope.getOrInit(
      administrationFacade,
      () =>
        new AdministrationActorFacade(
          this.scope.actor(),
          this.scope.getOrInit(clientService, () =>
            createClientService(this.scope.db),
          ),
          this.scope.getOrInit(appStateService, () =>
            createAppStateService(this.scope.db),
          ),
          this.scope.getOrInit(httpsUpgradeService, () =>
            createHttpsUpgradeService(this.scope.db),
          ),
          this.scope.getOrInit(announcementService, () =>
            createAnnouncementService(this.scope.db),
          ),
          this.scope.getOrInit(adminSystemService, () =>
            createAdminSystemService(this.scope.db, this.scope.sticky.update),
          ),
          this.scope.getOrInit(teachDocumentsService, () =>
            createTeachDocumentsService(
              this.scope.db,
              this.scope.blobs,
              this.scope.sticky.teachDocuments,
            ),
          ),
          this.scope.getOrInit(auditService, () =>
            createAuditService(this.scope.db),
          ),
          this.scope.unitOfWork,
        ),
    );
  }

  app(): AppFacade {
    return this.scope.getOrInit(
      appFacade,
      () =>
        new AppFacade(
          this.scope.identity,
          this.scope.authority(),
          this.scope.getOrInit(appStateService, () =>
            createAppStateService(this.scope.db),
          ),
          this.scope.getOrInit(clientService, () =>
            createClientService(this.scope.db),
          ),
          this.scope.getOrInit(httpsUpgradeService, () =>
            createHttpsUpgradeService(this.scope.db),
          ),
        ),
    );
  }

  authentication(): AuthenticationFacade {
    return this.scope.getOrInit(
      authenticationFacade,
      () =>
        new AuthenticationFacade(
          this.scope.getOrInit(authService, () =>
            createAuthService(this.scope.db, this.scope.identity),
          ),
        ),
    );
  }

  incidents(): IncidentFacade {
    return this.scope.getOrInit(
      incidentFacade,
      () =>
        new IncidentFacade(
          this.scope.actor(),
          this.scope.identity,
          this.scope.getOrInit(incidentService, () =>
            createIncidentService(this.scope.db, BUILD_ID),
          ),
          this.scope.getOrInit(
            incidentLogArchiveService,
            () => new IncidentLogArchiveService(this.scope.db, BUILD_ID),
          ),
        ),
    );
  }

  access(): AccessService {
    return this.scope.getOrInit(
      accessService,
      () => new AccessService(this.scope.db),
    );
  }

  ownerless(): OwnerlessCapabilityService {
    return this.scope.getOrInit(
      ownerlessCapabilityService,
      () =>
        new OwnerlessCapabilityService(
          this.scope.db,
          new CapabilityService(getCapabilitySecret(this.scope.db)),
          this.access(),
          ownerlessRecoveryFor(this.scope.db),
        ),
    );
  }

  media(): MediaActorFacade {
    return this.scope.getOrInit(
      mediaFacade,
      () =>
        new MediaActorFacade(
          this.scope.actor(),
          this.scope.getOrInit(
            mediaService,
            () => new MediaService(this.scope.db, this.scope.sticky.media),
          ),
          this.scope.getOrInit(
            mediaPlaylistService,
            () =>
              new MediaPlaylistService(
                this.scope.db,
                this.access(),
                this.ownerless(),
              ),
          ),
          this.scope.getOrInit(auditService, () =>
            createAuditService(this.scope.db),
          ),
          this.access(),
          this.ownerless(),
        ),
    );
  }
}
