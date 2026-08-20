import { z } from "zod";
import {
  articleSidebarPayloadSchema,
  articleWithMetaSchema,
  adminGroupSchema,
  booklistSnapshotSchema,
  booklistSummarySchema,
  conversationEntitySchema,
  groupSchema,
  groupMemberSchema,
  postSchema,
  stickerPackSummarySchema,
  stickerRecentItemSchema,
  userSchema,
  userMetadataSchema,
  userWordProgressSchema,
  wordQuizPayloadSchema,
  wordStatsSchema,
  wordWithLearnedCountSchema,
  wordWithWrongCountSchema,
  aiConversationSchema,
  aiConversationDetailSchema,
  aiCreditBalanceSchema,
  aiCreditLedgerEntrySchema,
  aiBillingPolicySchema,
  aiBillingSummarySchema,
} from "@/shared/types/api";
import {
  bundleFetchInputSchema,
  bundleOpenInputSchema,
  bundleSliceSchema,
} from "@/shared/bundles/protocol";
import { appStatePayloadSchema } from "@/shared/types/events";
import {
  mediaConfigSchema,
  mediaPlaylistSnapshotSchema,
  mediaPlaylistSummarySchema,
  mediaQueueSnapshotSchema,
  mediaTrackSchema,
  signedMediaTrackSchema,
} from "@/shared/media/types";
import {
  accessBindingSchema,
  accessGrantSchema,
  capabilityTokenSchema,
  principalRefSchema,
} from "@/shared/access";
import {
  createPostPayloadSchema,
  createStickerPostPayloadSchema,
} from "@/shared/validation/posts";
import type { ActionResult } from "./result";
import { incidentIdSchema } from "./errors";
import { userFeaturesSchema } from "@/shared/features";
import { adminRoleSchema } from "@/shared/authority";

const object = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const noArgs = z.tuple([]);
const one = <T extends z.ZodType>(schema: T) => z.tuple([schema]);
const optionalOne = <T extends z.ZodType>(schema: T) =>
  z.union([noArgs, one(schema)]);
const contract = <A extends z.ZodType<unknown[]>, O extends z.ZodType>(
  args: A,
  output: O,
) => ({ args, output });

const nonEmptyString = z.string().min(1);
const timestamp = z.number().int().nonnegative();
const okSchema = object({ ok: z.literal(true) });
const booleanValueSchema = object({ value: z.boolean(), updatedAt: timestamp });
const versionSchema = object({
  value: z.string().nullable(),
  updatedAt: timestamp,
});
const configSchema = object({
  idle_lock_enabled: z.boolean(),
  system_locked: z.boolean(),
  https_redirect_enabled: z.boolean(),
  whitelist_enabled: z.boolean(),
  identity_methods: z.array(z.enum(["mac", "ip", "user_agent"])).min(1),
  announcement_content: z.string(),
  announcement_revision: z.number().int().nonnegative(),
  cloud_deploy_enabled: z.boolean(),
  update_auto_check: z.boolean(),
  update_manifest_url: z.string(),
});
const announcementSchema = object({
  content: z.string(),
  revision: z.number().int().nonnegative(),
  acknowledged: z.boolean(),
});
const auditEntrySchema = object({
  id: z.string().uuid(),
  actor_id: z.string().nullable(),
  action: z.string(),
  target_kind: z.string(),
  target_id: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
  created_at: z.string(),
});

const discoverySectionSchema = object({
  parent: object({ id: z.string(), name: z.string() }),
  groups: z.array(groupSchema),
});
const ghostUserSchema = object({
  id: z.string(),
  created_at: z.string(),
  pending_oobe: z.number().int(),
});
const clientRecordSchema = object({
  id: z.string(),
  created_at: z.string(),
  persistent: z.boolean(),
  remark: z.string(),
  ips: z.array(z.string()),
  last_seen: z.string().nullable(),
  active_sessions: z.number().int().nonnegative(),
  session_user_ids: z.array(z.string()),
  konami_locked: z.boolean(),
  throttled_until: z.string().nullable(),
  attempts: z.number().int(),
  mac: z.string().nullable(),
  user_agent: z.string().nullable(),
  whitelisted: z.boolean(),
  bound_user_id: z.string().nullable(),
});
const backupSchema = object({
  name: z.string(),
  size: z.number().nonnegative(),
  created_at: z.string(),
});
const updateStatusSchema = object({
  pending: z.boolean(),
  applied_at: z.string().nullable(),
  seconds_remaining: z.number().int().nonnegative(),
  timeout_seconds: z.number().int().nonnegative(),
  disabled: z.boolean(),
  cloud_checking: z.boolean(),
  cloud_installing: z.boolean(),
  cloud_latest_build_id: z.string().nullable(),
  cloud_update_available: z.boolean(),
  cloud_last_checked_at: z.string().nullable(),
  cloud_last_error: z.string().nullable(),
});
const httpsStatusSchema = object({
  configured: z.boolean(),
  domain: z.string().nullable(),
  secure_ports: z.array(z.number().int().positive()),
  redirect_enabled: z.boolean(),
  dns_records: z.array(
    object({
      type: z.enum(["A", "AAAA"]),
      name: z.string(),
      value: z.string(),
    }),
  ),
  certificate: object({
    present: z.boolean(),
    valid: z.boolean(),
    hostname_valid: z.boolean(),
    not_before: z.string().nullable(),
    not_after: z.string().nullable(),
    days_remaining: z.number().int().nullable(),
    root_subject: z.string().nullable(),
    root_valid_from: z.string().nullable(),
    root_compatible: z.boolean().nullable(),
    error: z.string().nullable(),
  }),
});
const stickerEntrySchema = object({ name: z.string(), path: z.string() });
const stickerPackSchema = object({
  id: z.string(),
  name: z.string(),
  stickers: z.record(z.string(), stickerEntrySchema),
});
const networkArticleResultSchema = object({
  source: z.literal("tomato"),
  book_id: z.string(),
  title: z.string(),
  author: z.string().nullable(),
  abstract: z.string(),
  word_count: z.number().nullable(),
});
const articleImportTaskSchema = object({
  id: z.string(),
  source: z.literal("tomato"),
  user_id: z.string(),
  book_id: z.string(),
  title: z.string(),
  status: z.enum(["queued", "downloading", "completed", "failed"]),
  progress: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  eta_ms: z.number().int().nonnegative(),
  article_id: z.string().nullable(),
  error: z.string().nullable(),
  created_at: timestamp,
  updated_at: timestamp,
  group_id: nonEmptyString,
});
const teachDocumentSchema = object({
  id: z.string().uuid(),
  application: z.string(),
  document_type: z.enum(["word", "powerpoint", "excel"]),
  name: z.string(),
  file_size: z.number().int().nonnegative(),
  created_at: z.string(),
});
const incidentEnvironmentSchema = z.enum(["server", "client"]);
const incidentGroupSchema = object({
  id: z.number().int().positive(),
  environment: incidentEnvironmentSchema,
  build_id: z.string(),
  fingerprint: z.string(),
  top_frame: z.string(),
  occurrence_count: z.number().int().nonnegative(),
  stored_detail_count: z.number().int().nonnegative(),
  first_at: z.string(),
  last_at: z.string(),
});
const incidentDetailSchema = object({
  id: z.number().int().positive(),
  public_id: incidentIdSchema,
  group_id: z.number().int().positive(),
  occurred_at: z.string(),
  error_name: z.string().nullable(),
  message: z.string().nullable(),
  stack: z.string().nullable(),
  context_json: z.string().nullable(),
  related_incident_ids_json: z.string().nullable(),
  context: z.unknown().nullable(),
  related_incident_ids: z.array(incidentIdSchema),
});

const groupCreateInputSchema = object({
  handle: z.string().optional(),
  name: nonEmptyString,
  password: z.string().optional(),
  discoverable: z.boolean().optional(),
  parent_group_id: z.string().nullable().optional(),
});
const adminGroupCreateInputSchema = object({
  handle: z.string().optional(),
  name: nonEmptyString,
  password: z.string().optional(),
  type: z.string().optional(),
  discoverable: z.boolean().optional(),
  members_hidden: z.boolean().optional(),
  admin_only: z.boolean().optional(),
  no_leave: z.boolean().optional(),
  parent_group_id: z.string().nullable().optional(),
});
const conversationRefSchema = object({
  type: z.enum(["group", "dm"]),
  id: nonEmptyString,
});

export const actionContracts = {
  adminFetchUsersAction: contract(
    optionalOne(
      object({
        q: z.string().optional(),
        offset: z.union([z.number(), z.string()]).optional(),
      }),
    ),
    object({
      users: z.array(userSchema),
      total: z.number().int().nonnegative(),
    }),
  ),
  adminCreateUserAction: contract(
    one(
      object({
        ghost: z.boolean().optional(),
        handle: z.string().optional(),
        username: z.string().optional(),
        pin: z.string().optional(),
        features: userFeaturesSchema.optional(),
      }),
    ),
    z.union([
      object({ pin: z.string(), ghost_id: z.string() }),
      object({ user: userSchema }),
    ]),
  ),
  adminMutateUsersAction: contract(
    one(
      object({
        changes: z
          .array(
            object({
              userId: nonEmptyString,
              handle: z.string().optional(),
              username: z.string().optional(),
              features: userFeaturesSchema.optional(),
              roles: z.array(adminRoleSchema).optional(),
              pin: z.string().optional(),
              mute_hours: z.number().positive().optional(),
              unmute: z.boolean().optional(),
              ban_hours: z.number().positive().optional(),
              unban: z.boolean().optional(),
              removal: z.enum(["purge", "deactivate"]).optional(),
            }),
          )
          .min(1)
          .max(500),
      }),
    ),
    okSchema,
  ),
  adminFetchAuditLogAction: contract(
    optionalOne(object({ offset: z.number().int().nonnegative().optional() })),
    object({
      entries: z.array(auditEntrySchema),
      users: z.array(userMetadataSchema),
    }),
  ),
  adminFetchGhostUsersAction: contract(
    noArgs,
    object({ ghosts: z.array(ghostUserSchema) }),
  ),
  adminDeleteGhostUserAction: contract(one(nonEmptyString), okSchema),
  adminFetchGroupsAction: contract(
    optionalOne(
      object({ offset: z.union([z.number(), z.string()]).optional() }),
    ),
    object({
      groups: z.array(adminGroupSchema),
      total: z.number().int().nonnegative(),
    }),
  ),
  adminCreateGroupAction: contract(
    one(adminGroupCreateInputSchema),
    object({ group: groupSchema }),
  ),
  adminMutateGroupsAction: contract(
    one(
      object({
        changes: z
          .array(
            object({
              groupId: nonEmptyString,
              handle: z.string().optional(),
              name: z.string().optional(),
              password: z.string().optional(),
              clearPassword: z.boolean().optional(),
              type: z.string().optional(),
              discoverable: z.boolean().optional(),
              members_hidden: z.boolean().optional(),
              admin_only: z.boolean().optional(),
              no_leave: z.boolean().optional(),
              parent_group_id: z.string().nullable().optional(),
              memberAction: z.enum(["add", "remove"]).optional(),
              userId: z.string().optional(),
              delete: z.boolean().optional(),
            }),
          )
          .min(1)
          .max(500),
      }),
    ),
    okSchema,
  ),
  adminFetchClientsAction: contract(
    optionalOne(
      object({
        q: z.string().optional(),
        offset: z.union([z.number(), z.string()]).optional(),
      }),
    ),
    object({
      clients: z.array(clientRecordSchema),
      users: z.array(userMetadataSchema),
      total: z.number().int().nonnegative(),
    }),
  ),
  adminMutateClientsAction: contract(
    one(
      object({
        changes: z
          .array(
            object({
              id: nonEmptyString,
              promote: z.boolean().optional(),
              locked: z.boolean().optional(),
              remark: z.string().max(100).optional(),
              whitelisted: z.boolean().optional(),
              bound_user_id: z.string().nullable().optional(),
              delete: z.boolean().optional(),
            }),
          )
          .min(1)
          .max(500),
      }),
    ),
    okSchema,
  ),
  adminWhitelistCurrentClientAction: contract(
    noArgs,
    object({ ok: z.literal(true), client_id: z.string() }),
  ),
  adminFetchConfigAction: contract(noArgs, configSchema),
  adminUpdateConfigAction: contract(
    one(
      object({
        idle_lock_enabled: z.boolean().optional(),
        system_locked: z.boolean().optional(),
        https_redirect_enabled: z.boolean().optional(),
        whitelist_enabled: z.boolean().optional(),
        identity_methods: z
          .array(z.enum(["mac", "ip", "user_agent"]))
          .min(1)
          .optional(),
        announcement_content: z.string().max(10000).optional(),
        cloud_deploy_enabled: z.boolean().optional(),
        update_auto_check: z.boolean().optional(),
        update_manifest_url: z.string().max(2048).optional(),
      }),
    ),
    object({ ok: z.literal(true), ...configSchema.shape }),
  ),
  fetchAnnouncementAction: contract(noArgs, announcementSchema),
  acknowledgeAnnouncementAction: contract(
    one(z.number().int().nonnegative()),
    object({ ok: z.literal(true), acknowledged: z.boolean() }),
  ),
  adminFetchBackupsAction: contract(
    noArgs,
    object({ backups: z.array(backupSchema) }),
  ),
  adminCreateBackupAction: contract(
    noArgs,
    object({ ok: z.literal(true), backups: z.array(backupSchema) }),
  ),
  adminDeleteBackupAction: contract(one(nonEmptyString), okSchema),
  adminFetchUpdateStatusAction: contract(noArgs, updateStatusSchema),
  adminCheckCloudUpdateAction: contract(
    noArgs,
    object({ build_id: z.string(), update_available: z.boolean() }),
  ),
  adminInstallCloudUpdateAction: contract(
    noArgs,
    object({ ok: z.literal(true), message: z.string() }),
  ),
  adminFetchHttpsStatusAction: contract(noArgs, httpsStatusSchema),
  adminConfirmUpdateAction: contract(noArgs, okSchema),
  adminRollbackAction: contract(
    noArgs,
    object({ ok: z.literal(true), message: z.string() }),
  ),
  adminRunToolAction: contract(
    one(z.enum(["kill-wps", "shutdown"])),
    object({ ok: z.literal(true), message: z.string() }),
  ),
  adminFetchTeachDocumentsAction: contract(
    noArgs,
    object({
      documents: z.array(teachDocumentSchema),
      monitor_available: z.boolean(),
    }),
  ),
  adminCleanupTeachDocumentsAction: contract(
    noArgs,
    object({ ok: z.literal(true), deleted: z.number().int().nonnegative() }),
  ),
  adminFetchIncidentGroupsAction: contract(
    optionalOne(
      object({
        environment: incidentEnvironmentSchema.optional(),
        buildId: z.string().optional(),
        offset: z.number().int().nonnegative().optional(),
      }),
    ),
    object({ groups: z.array(incidentGroupSchema) }),
  ),
  adminFetchIncidentDetailsAction: contract(
    one(z.number().int().positive()),
    object({ incidents: z.array(incidentDetailSchema) }),
  ),
  adminTestIncidentAction: contract(noArgs, okSchema),

  reportClientIncidentAction: contract(
    one(
      object({
        buildId: z.string().max(256),
        errorName: z.string().max(200),
        message: z.string().max(4000),
        stack: z.string().max(32000),
        operation: z.string().max(256),
        operationId: z.string().regex(/^[a-f0-9]{24}$/),
        relatedIncidentIds: z.array(incidentIdSchema).max(32),
      }),
    ),
    object({ incidentId: incidentIdSchema }),
  ),

  probeAppStateAction: contract(
    optionalOne(object({ touch: z.boolean().optional() })),
    appStatePayloadSchema,
  ),
  getClientMeAction: contract(
    noArgs,
    object({
      client_id: z.string().nullable(),
      ip: z.string(),
      client_invalid: z.boolean().optional(),
    }),
  ),
  patchClientMeAction: contract(
    one(z.boolean()),
    z.union([
      object({ ok: z.literal(false), client_invalid: z.literal(true) }),
      object({ ok: z.literal(true), konami_locked: z.boolean() }),
      object({
        ok: z.literal(false),
        access_required: z.literal(true),
        client_id: z.string(),
      }),
    ]),
  ),

  autoLoginAction: contract(
    noArgs,
    object({
      user: userSchema.nullable(),
      token: z.string().optional(),
      konami_locked: z.boolean(),
      banned: z.boolean().optional(),
      banned_until: z.string().optional(),
      username: z.string().optional(),
    }),
  ),
  loginPinAction: contract(
    one(z.string().regex(/^\d{6}$/)),
    z.union([
      object({ error: z.string() }),
      object({ user: userSchema, token: z.string() }),
      object({ needs_oobe: z.literal(true), oobe_token: z.string() }),
      object({
        banned: z.literal(true),
        banned_until: z.string(),
        username: z.string(),
      }),
    ]),
  ),
  completeOobeAction: contract(
    one(
      object({
        oobe_token: nonEmptyString,
        handle: z.string().regex(/^[a-zA-Z0-9_]{1,20}$/),
        username: z.string().trim().min(1).max(30),
        new_pins: z
          .array(z.string().regex(/^\d{6}$/))
          .min(1)
          .max(2),
      }),
    ),
    z.union([
      object({ user: userSchema, token: z.string() }),
      object({ error: z.string() }),
    ]),
  ),
  logoutAction: contract(noArgs, okSchema),
  updateMeAction: contract(
    one(
      object({
        handle: z.string().optional(),
        username: z.string().optional(),
        resetPins: object({
          current_pin: z.string(),
          new_pins: z.array(z.string()),
        }).optional(),
      }),
    ),
    z.union([okSchema, object({ user: userSchema })]),
  ),

  listArticlesAction: contract(
    one(
      object({
        view: z.enum(["all", "bookmarked", "recent"]).optional(),
        cursor: object({
          sortAt: z.string(),
          id: nonEmptyString,
        }).optional(),
        direction: z.enum(["before", "after"]).optional(),
        group_id: nonEmptyString.optional(),
      }),
    ),
    object({
      articles: z.array(articleWithMetaSchema),
      users: z.array(userMetadataSchema),
      hasMore: z.boolean(),
    }),
  ),
  fetchArticleSidebarAction: contract(noArgs, articleSidebarPayloadSchema),
  createArticleAction: contract(
    one(
      object({
        title: nonEmptyString,
        content: nonEmptyString,
        group_id: nonEmptyString,
      }),
    ),
    object({
      article: articleWithMetaSchema,
      users: z.array(userMetadataSchema),
      capability: capabilityTokenSchema,
    }),
  ),
  searchNetworkArticlesAction: contract(
    one(object({ query: nonEmptyString })),
    z.discriminatedUnion("status", [
      object({
        status: z.literal("ready"),
        results: z.array(networkArticleResultSchema),
      }),
      object({
        status: z.literal("busy"),
        retry_after_ms: z.number().int().nonnegative(),
        ready_at: timestamp,
      }),
    ]),
  ),
  startNetworkArticleDownloadAction: contract(
    one(
      object({
        book_id: nonEmptyString,
        title: z.string().optional(),
        group_id: nonEmptyString,
      }),
    ),
    object({ task: articleImportTaskSchema }),
  ),
  listNetworkArticleDownloadsAction: contract(
    noArgs,
    object({ tasks: z.array(articleImportTaskSchema) }),
  ),
  articlesLibraryAction: contract(
    noArgs,
    object({
      recents: z.array(articleWithMetaSchema),
      favorites: z.array(articleWithMetaSchema),
      booklists: z.array(booklistSummarySchema),
      users: z.array(userMetadataSchema),
    }),
  ),
  booklistListAction: contract(
    noArgs,
    object({ booklists: z.array(booklistSummarySchema) }),
  ),
  booklistFetchAction: contract(one(nonEmptyString), booklistSnapshotSchema),
  booklistForGroupAction: contract(
    one(object({ groupId: nonEmptyString })),
    booklistSnapshotSchema.nullable(),
  ),
  booklistCreateAction: contract(
    one(object({ title: z.string().min(1).max(80) })),
    booklistSnapshotSchema,
  ),
  booklistDeleteAction: contract(one(nonEmptyString), okSchema),
  booklistAddArticleAction: contract(
    one(
      object({
        booklistId: nonEmptyString,
        articleId: nonEmptyString,
        capability: capabilityTokenSchema.optional(),
      }),
    ),
    booklistSnapshotSchema,
  ),
  booklistRemoveArticleAction: contract(
    one(
      object({
        booklistId: nonEmptyString,
        articleId: nonEmptyString,
      }),
    ),
    booklistSnapshotSchema,
  ),
  booklistGrantAccessAction: contract(
    one(
      object({
        booklistId: nonEmptyString,
        principal: principalRefSchema,
        grant: accessGrantSchema,
      }),
    ),
    booklistSnapshotSchema,
  ),
  booklistRevokeAccessAction: contract(
    one(
      object({
        booklistId: nonEmptyString,
        principal: principalRefSchema,
      }),
    ),
    booklistSnapshotSchema,
  ),
  booklistListBindingsAction: contract(
    one(object({ booklistId: nonEmptyString })),
    object({ bindings: z.array(accessBindingSchema) }),
  ),
  fetchArticleAction: contract(
    one(
      object({
        articleId: nonEmptyString,
        capability: capabilityTokenSchema.optional(),
      }),
    ),
    object({
      article: articleWithMetaSchema,
      users: z.array(userMetadataSchema),
    }),
  ),
  fetchArticleSegmentAction: contract(
    one(
      object({
        articleId: nonEmptyString,
        offset: z.number().int().nonnegative(),
        capability: capabilityTokenSchema.optional(),
      }),
    ),
    object({
      content: z.string(),
      offset: z.number().int().nonnegative(),
      has_more: z.boolean(),
      content_length: z.number().int().nonnegative(),
    }),
  ),
  openArticleBundleAction: contract(
    one(bundleOpenInputSchema),
    bundleSliceSchema,
  ),
  fetchArticleBundleItemsAction: contract(
    one(bundleFetchInputSchema),
    bundleSliceSchema,
  ),
  setArticleBookmarkAction: contract(
    one(
      object({
        articleId: nonEmptyString,
        bookmarked: z.boolean(),
        updatedAt: timestamp,
        capability: capabilityTokenSchema.optional(),
      }),
    ),
    booleanValueSchema,
  ),
  saveArticleProgressAction: contract(
    one(
      object({
        articleId: nonEmptyString,
        offset: z.number().int().nonnegative(),
        updatedAt: timestamp,
        merge: z.enum(["override", "furthest"]),
        capability: capabilityTokenSchema.optional(),
      }),
    ),
    object({ offset: z.number().int().nonnegative(), updatedAt: timestamp }),
  ),
  reportArticleReadingAction: contract(
    one(
      object({
        articleId: nonEmptyString,
        seconds: z.number().finite().nonnegative(),
        active: z.boolean(),
        capability: capabilityTokenSchema.optional(),
      }),
    ),
    okSchema,
  ),
  deleteArticleAction: contract(
    one(
      object({
        articleId: nonEmptyString,
        capability: capabilityTokenSchema.optional(),
      }),
    ),
    okSchema,
  ),

  fetchConversationsAction: contract(
    noArgs,
    object({
      entries: z.array(conversationEntitySchema),
      users: z.array(userMetadataSchema),
    }),
  ),
  fetchConversationRevisionsAction: contract(
    noArgs,
    object({
      revisions: z.array(
        object({
          conv_id: nonEmptyString,
          revision: z.number().int().nonnegative(),
          revision_sum: z.string().regex(/^\d+$/),
        }),
      ),
    }),
  ),
  markConversationReadAction: contract(
    one(
      conversationRefSchema
        .extend({
          post_id: nonEmptyString,
          updatedAt: timestamp,
          merge: z.enum(["override", "furthest"]),
        })
        .strict(),
    ),
    object({
      postId: z.string().nullable(),
      sequence: z.number().int().nonnegative(),
      updatedAt: timestamp,
    }),
  ),
  setConversationPinnedAction: contract(
    one(
      conversationRefSchema
        .extend({ pinned: z.boolean(), updatedAt: timestamp })
        .strict(),
    ),
    booleanValueSchema,
  ),
  setConversationMutedAction: contract(
    one(
      conversationRefSchema
        .extend({ muted: z.boolean(), updatedAt: timestamp })
        .strict(),
    ),
    booleanValueSchema,
  ),
  fetchConversationDraftAction: contract(
    one(conversationRefSchema),
    object({ draft: z.string(), updatedAt: timestamp }),
  ),
  saveConversationDraftAction: contract(
    one(
      conversationRefSchema
        .extend({ draft: z.string(), updatedAt: timestamp })
        .strict(),
    ),
    object({ draft: z.string(), updatedAt: timestamp }),
  ),

  createGroupAction: contract(
    one(groupCreateInputSchema),
    object({ group: groupSchema }),
  ),
  discoverGroupsAction: contract(
    optionalOne(object({ query: z.string().optional() })),
    object({ sections: z.array(discoverySectionSchema) }),
  ),
  discoverSubgroupsAction: contract(
    one(object({ groupId: nonEmptyString, query: z.string().optional() })),
    object({ groups: z.array(groupSchema) }),
  ),
  joinGroupAction: contract(
    one(
      object({
        groupId: nonEmptyString,
        source: z.discriminatedUnion("type", [
          object({ type: z.literal("search") }),
          object({ type: z.literal("group"), groupId: nonEmptyString }),
        ]),
        password: z.string().optional(),
      }),
    ),
    z.union([
      object({ ok: z.literal(true), group: groupSchema }),
      object({
        ok: z.literal(false),
        error: z.string(),
        needs_password: z.boolean(),
      }),
    ]),
  ),
  leaveGroupAction: contract(one(nonEmptyString), okSchema),
  fetchGroupMembersAction: contract(
    one(nonEmptyString),
    object({
      members: z.array(groupMemberSchema),
      users: z.array(userMetadataSchema),
      hidden: z.boolean(),
      no_leave: z.boolean(),
      self_hide_self: z.boolean(),
    }),
  ),
  patchMyGroupMembershipAction: contract(
    one(object({ groupId: nonEmptyString, hide_self: z.boolean() })),
    object({ ok: z.literal(true), hide_self: z.boolean() }),
  ),

  fetchNotificationConfigAction: contract(
    noArgs,
    object({ doNotDisturb: z.boolean() }),
  ),
  updateDoNotDisturbAction: contract(
    one(object({ enabled: z.boolean() })),
    object({ doNotDisturb: z.boolean() }),
  ),

  fetchPostsAction: contract(
    one(
      object({
        type: z.enum(["feed", "conversation"]).optional(),
        conv_id: nonEmptyString.optional(),
        before_id: z.string().optional(),
        after_id: z.string().optional(),
        before_sequence: z.number().int().nonnegative().optional(),
        after_sequence: z.number().int().nonnegative().optional(),
        changed_after_revision: z.number().int().nonnegative().optional(),
        changed_through_revision: z.number().int().nonnegative().optional(),
        limit: z.string().optional(),
        offset: z.string().optional(),
      }),
    ),
    object({ posts: z.array(postSchema), users: z.array(userMetadataSchema) }),
  ),
  fetchPostAction: contract(
    one(nonEmptyString),
    object({ post: postSchema, users: z.array(userMetadataSchema) }),
  ),
  createPostAction: contract(
    one(
      object({
        content: z.union([z.string(), createPostPayloadSchema]).optional(),
        conv_id: nonEmptyString,
        reply_to: z.string().optional(),
      }),
    ),
    object({ post: postSchema, users: z.array(userMetadataSchema) }),
  ),
  updatePostAction: contract(
    one(object({ postId: nonEmptyString, text: z.string() })),
    object({ post: postSchema, users: z.array(userMetadataSchema) }),
  ),
  deletePostAction: contract(
    one(nonEmptyString),
    object({ post: postSchema, users: z.array(userMetadataSchema) }),
  ),

  fetchStickerPacksAction: contract(
    noArgs,
    object({ packs: z.array(stickerPackSummarySchema) }),
  ),
  fetchStickerPackAction: contract(
    one(nonEmptyString),
    object({ pack: stickerPackSchema }),
  ),
  fetchRecentStickersAction: contract(
    noArgs,
    object({ recent: z.array(stickerRecentItemSchema) }),
  ),
  touchRecentStickerAction: contract(
    one(object({ pack: nonEmptyString, id: nonEmptyString })),
    object({ recent: z.array(stickerRecentItemSchema) }),
  ),
  sendStickerPostAction: contract(
    one(
      object({
        content: createStickerPostPayloadSchema.optional(),
        conv_id: nonEmptyString,
        reply_to: z.string().optional(),
      }),
    ),
    object({ post: postSchema, users: z.array(userMetadataSchema) }),
  ),

  fetchVersionedUserConfigAction: contract(
    one(object({ keys: z.array(nonEmptyString) })),
    z.record(z.string(), versionSchema),
  ),
  patchVersionedUserConfigAction: contract(
    one(
      object({ key: nonEmptyString, value: z.string(), updatedAt: timestamp }),
    ),
    versionSchema,
  ),

  fetchWordStatsAction: contract(
    optionalOne(object({ timezoneOffset: z.number().finite().optional() })),
    object({ stats: wordStatsSchema }),
  ),
  fetchNextWordAction: contract(noArgs, wordQuizPayloadSchema),
  fetchNextWrongWordAction: contract(noArgs, wordQuizPayloadSchema),
  fetchSelfDisciplineWordAction: contract(noArgs, wordQuizPayloadSchema),
  recordWordPracticeAction: contract(
    one(
      object({
        wordId: nonEmptyString,
        correct: z.boolean(),
        mastered: z.boolean().optional(),
      }),
    ),
    object({ progress: userWordProgressSchema }),
  ),
  fetchWrongWordsAction: contract(
    optionalOne(
      object({
        offset: z.number().finite().optional(),
        limit: z.number().finite().positive().optional(),
      }),
    ),
    object({
      words: z.array(wordWithWrongCountSchema),
      total: z.number().int().nonnegative(),
    }),
  ),
  fetchMasteredWordsAction: contract(
    optionalOne(
      object({
        offset: z.number().finite().optional(),
        limit: z.number().finite().positive().optional(),
      }),
    ),
    object({
      words: z.array(wordWithLearnedCountSchema),
      total: z.number().int().nonnegative(),
    }),
  ),
  importWordsAction: contract(
    one(object({ text: z.string() })),
    object({ imported: z.number().int().nonnegative() }),
  ),
  fetchSelfDisciplineModeAction: contract(
    noArgs,
    object({ enabled: z.boolean() }),
  ),
  updateSelfDisciplineModeAction: contract(
    one(object({ enabled: z.boolean() })),
    object({ enabled: z.boolean() }),
  ),
  adminFetchSelfDisciplineModeAction: contract(
    one(object({ userId: nonEmptyString })),
    object({ enabled: z.boolean() }),
  ),
  adminUpdateSelfDisciplineModeAction: contract(
    one(object({ userId: nonEmptyString, enabled: z.boolean() })),
    object({ enabled: z.boolean() }),
  ),
  fetchAiSidebarAction: contract(
    noArgs,
    object({
      conversations: z.array(aiConversationSchema),
      credits: aiCreditBalanceSchema,
      status: z.discriminatedUnion("available", [
        object({ available: z.literal(true), error: z.null() }),
        object({ available: z.literal(false), error: z.string() }),
      ]),
    }),
  ),
  fetchAiConversationAction: contract(
    one(object({ conversationId: z.string().uuid() })),
    aiConversationDetailSchema,
  ),
  searchAiConversationsAction: contract(
    one(object({ query: z.string().max(500) })),
    object({ conversations: z.array(aiConversationSchema) }),
  ),
  startAiRunAction: contract(
    one(
      object({
        conversationId: z.string().uuid().optional(),
        content: z.string().trim().min(1).max(100_000),
        images: z
          .array(
            object({
              name: z.string().min(1).max(200),
              mime: z.enum([
                "image/png",
                "image/jpeg",
                "image/webp",
                "image/gif",
              ]),
              data: z.string().min(1).max(7_000_000),
            }),
          )
          .max(4)
          .optional(),
        forkFromMessageId: z.string().uuid().optional(),
      }),
    ),
    z.discriminatedUnion("status", [
      object({
        status: z.literal("started"),
        runId: z.string().uuid(),
        conversationId: z.string().uuid(),
      }),
      object({
        status: z.literal("insufficient_credits"),
        required: z.number().int().nonnegative(),
        available: z.number().int().nonnegative(),
      }),
      object({ status: z.literal("busy") }),
      object({ status: z.literal("unavailable"), error: z.string() }),
    ]),
  ),
  cancelAiRunAction: contract(
    one(object({ runId: z.string().uuid() })),
    object({ cancelled: z.boolean() }),
  ),
  markAiConversationReadAction: contract(
    one(object({ conversationId: z.string().uuid() })),
    okSchema,
  ),
  adminFetchAiCreditsAction: contract(
    one(object({ userId: nonEmptyString })),
    object({
      credits: aiCreditBalanceSchema,
      ledger: z.array(aiCreditLedgerEntrySchema),
    }),
  ),
  adminFetchAiBillingAction: contract(noArgs, aiBillingSummarySchema),
  adminUpdateAiBillingPolicyAction: contract(
    one(
      object({
        dailyAllowance: z.number().nonnegative().max(1_000_000_000),
        weeklyAllowance: z.number().nonnegative().max(1_000_000_000),
        defaultPlanDurationDays: z.number().int().positive().max(3650),
      }),
    ),
    aiBillingPolicySchema,
  ),
  adminAssignAiCreditsAction: contract(
    one(
      object({
        targets: z
          .array(
            object({
              userId: nonEmptyString,
              idempotencyKey: z.string().uuid(),
            }),
          )
          .min(1)
          .max(500),
        durationDays: z.number().int().positive().max(3650).optional(),
        amount: z.number().int().positive().max(1_000_000_000).optional(),
        note: z.string().max(200),
      }),
    ),
    okSchema,
  ),

  // ── Media ──────────────────────────────────────────────────────────────────
  mediaSearchAction: contract(
    one(
      object({
        query: nonEmptyString,
        limit: z.number().int().positive().max(50).optional(),
      }),
    ),
    object({ tracks: z.array(signedMediaTrackSchema) }),
  ),
  mediaEnsureTrackAction: contract(
    one(
      object({
        source: nonEmptyString,
        providerId: nonEmptyString,
        canonicalUrl: z.string().optional(),
      }),
    ),
    object({ track: mediaTrackSchema, capability: capabilityTokenSchema }),
  ),
  mediaFetchQueueAction: contract(noArgs, mediaQueueSnapshotSchema),
  mediaAddToQueueAction: contract(
    one(
      object({
        trackId: nonEmptyString,
        capability: capabilityTokenSchema.optional(),
      }),
    ),
    mediaQueueSnapshotSchema,
  ),
  mediaRemoveFromQueueAction: contract(
    one(object({ trackId: nonEmptyString })),
    mediaQueueSnapshotSchema,
  ),
  mediaClearQueueAction: contract(noArgs, mediaQueueSnapshotSchema),
  mediaPlayAction: contract(
    one(
      object({
        trackId: nonEmptyString,
        capability: capabilityTokenSchema.optional(),
      }),
    ),
    object({
      grant_token: z.string(),
      url: z.string(),
      expires_at: z.number().int().nonnegative(),
    }),
  ),
  mediaListPlaylistsAction: contract(
    noArgs,
    object({ playlists: z.array(mediaPlaylistSummarySchema) }),
  ),
  mediaFetchPlaylistAction: contract(
    one(nonEmptyString),
    mediaPlaylistSnapshotSchema,
  ),
  mediaCreatePlaylistAction: contract(
    one(object({ title: z.string().min(1).max(80) })),
    mediaPlaylistSnapshotSchema,
  ),
  mediaDeletePlaylistAction: contract(one(nonEmptyString), okSchema),
  mediaAddToPlaylistAction: contract(
    one(
      object({
        playlistId: nonEmptyString,
        trackId: nonEmptyString,
        capability: capabilityTokenSchema.optional(),
      }),
    ),
    mediaPlaylistSnapshotSchema,
  ),
  mediaRemoveFromPlaylistAction: contract(
    one(
      object({
        playlistId: nonEmptyString,
        trackId: nonEmptyString,
      }),
    ),
    mediaPlaylistSnapshotSchema,
  ),
  mediaUpdatePlaylistRetentionAction: contract(
    one(
      object({
        playlistId: nonEmptyString,
        days: z.number().int().positive().max(365),
      }),
    ),
    mediaPlaylistSnapshotSchema,
  ),
  mediaGrantPlaylistAccessAction: contract(
    one(
      object({
        playlistId: nonEmptyString,
        principal: principalRefSchema,
        grant: accessGrantSchema,
      }),
    ),
    mediaPlaylistSnapshotSchema,
  ),
  mediaRevokePlaylistAccessAction: contract(
    one(
      object({
        playlistId: nonEmptyString,
        principal: principalRefSchema,
      }),
    ),
    mediaPlaylistSnapshotSchema,
  ),
  mediaListPlaylistBindingsAction: contract(
    one(object({ playlistId: nonEmptyString })),
    object({ bindings: z.array(accessBindingSchema) }),
  ),
  mediaLibraryAction: contract(
    noArgs,
    object({
      recents: z.array(signedMediaTrackSchema),
      favorites: z.array(signedMediaTrackSchema),
      playlists: z.array(mediaPlaylistSummarySchema),
    }),
  ),
  mediaSetTrackFavoriteAction: contract(
    one(
      object({
        trackId: nonEmptyString,
        favorited: z.boolean(),
        updatedAt: timestamp,
        capability: capabilityTokenSchema.optional(),
      }),
    ),
    booleanValueSchema,
  ),
  mediaFetchConfigAction: contract(noArgs, mediaConfigSchema),
  mediaAdminUpdateConfigAction: contract(
    one(
      object({
        max_volume: z.number().min(0).max(1).optional(),
        eviction_days: z.number().int().positive().max(3650).optional(),
        storage_limit_bytes: z
          .number()
          .int()
          .positive()
          .max(2 ** 48)
          .optional(),
      }),
    ),
    mediaConfigSchema,
  ),
} as const;

export type ActionName = keyof typeof actionContracts;
export type ActionArgs<K extends ActionName> =
  z.output<(typeof actionContracts)[K]["args"]> extends unknown[]
    ? z.output<(typeof actionContracts)[K]["args"]>
    : never;
type FirstArgument<T> = T extends [infer I] ? I : never;
export type ActionInput<K extends ActionName> = FirstArgument<ActionArgs<K>>;
export type ActionData<K extends ActionName> = z.output<
  (typeof actionContracts)[K]["output"]
>;

export type ActionFunctions = {
  [K in ActionName]: (
    ...args: ActionArgs<K>
  ) => Promise<ActionResult<ActionData<K>>>;
};

export type ActionHandlerFunctions = {
  [K in ActionName]: (...args: ActionArgs<K>) => Promise<ActionData<K>>;
};
