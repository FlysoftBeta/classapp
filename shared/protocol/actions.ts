import { z } from "zod";
import {
  articleSidebarPayloadSchema,
  articleWithContentAndMetaSchema,
  articleWithMetaSchema,
  adminGroupSchema,
  conversationSchema,
  groupSchema,
  groupMemberSchema,
  postSchema,
  stickerPackSummarySchema,
  stickerRecentItemSchema,
  userSchema,
  userWordProgressSchema,
  wordQuizPayloadSchema,
  wordStatsSchema,
  wordWithLearnedCountSchema,
  wordWithWrongCountSchema,
} from "@/shared/types/api";
import { appStatePayloadSchema } from "@/shared/types/events";
import { blobReaderConfigSchema } from "@/shared/userConfig/reader";
import {
  createPostPayloadSchema,
  createStickerPostPayloadSchema,
} from "@/shared/validation/posts";
import type { CheckedActionResult } from "./result";

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
});
const announcementSchema = object({
  content: z.string(),
  revision: z.number().int().nonnegative(),
  acknowledged: z.boolean(),
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
  session_users: z.string(),
  konami_locked: z.boolean(),
  throttled_until: z.string().nullable(),
  attempts: z.number().int(),
  mac: z.string().nullable(),
  user_agent: z.string().nullable(),
  whitelisted: z.boolean(),
  bound_user_id: z.string().nullable(),
  bound_user_handle: z.string().nullable(),
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
        feature_mask: z.number().int().optional(),
      }),
    ),
    z.union([
      object({ pin: z.string(), ghost_id: z.string() }),
      object({ user: userSchema }),
    ]),
  ),
  adminUpdateUserAction: contract(
    one(
      object({
        userId: nonEmptyString,
        handle: z.string().optional(),
        username: z.string().optional(),
        feature_mask: z.number().int().optional(),
        pin: z.string().optional(),
        mute_hours: z.number().positive().optional(),
        unmute: z.boolean().optional(),
        ban_hours: z.number().positive().optional(),
        unban: z.boolean().optional(),
      }),
    ),
    object({ user: userSchema }),
  ),
  adminDeleteUserAction: contract(
    one(
      object({
        userId: nonEmptyString,
        mode: z.enum(["purge", "deactivate"]),
      }),
    ),
    okSchema,
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
  adminUpdateGroupAction: contract(
    one(
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
        action: z.enum(["add_member", "remove_member"]).optional(),
        user_id: z.string().optional(),
      }),
    ),
    z.union([okSchema, object({ group: groupSchema })]),
  ),
  adminDeleteGroupAction: contract(one(nonEmptyString), okSchema),
  adminFetchPostsAction: contract(
    optionalOne(
      object({
        q: z.string().optional(),
        user: z.string().optional(),
        offset: z.union([z.number(), z.string()]).optional(),
      }),
    ),
    object({
      posts: z.array(postSchema),
      total: z.number().int().nonnegative(),
    }),
  ),
  adminDeletePostAction: contract(one(nonEmptyString), okSchema),
  adminFetchClientsAction: contract(
    optionalOne(
      object({
        q: z.string().optional(),
        offset: z.union([z.number(), z.string()]).optional(),
      }),
    ),
    object({
      clients: z.array(clientRecordSchema),
      total: z.number().int().nonnegative(),
    }),
  ),
  adminToggleClientLockAction: contract(
    one(object({ id: nonEmptyString, action: z.enum(["lock", "unlock"]) })),
    okSchema,
  ),
  adminDeleteClientAction: contract(one(nonEmptyString), okSchema),
  adminPromoteClientAction: contract(one(nonEmptyString), okSchema),
  adminUpdateClientAction: contract(
    one(
      object({
        id: nonEmptyString,
        remark: z.string().max(100).optional(),
        whitelisted: z.boolean().optional(),
        bound_user_id: z.string().nullable().optional(),
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
    object({ user: userSchema, token: z.string() }),
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
      article: articleWithContentAndMetaSchema,
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
  fetchArticleAction: contract(
    one(nonEmptyString),
    object({ article: articleWithMetaSchema }),
  ),
  fetchArticleSegmentAction: contract(
    one(
      object({
        articleId: nonEmptyString,
        offset: z.number().int().nonnegative(),
      }),
    ),
    object({
      content: z.string(),
      offset: z.number().int().nonnegative(),
      has_more: z.boolean(),
      content_length: z.number().int().nonnegative(),
    }),
  ),
  setArticleBookmarkAction: contract(
    one(
      object({
        articleId: nonEmptyString,
        bookmarked: z.boolean(),
        updatedAt: timestamp,
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
      }),
    ),
    okSchema,
  ),
  deleteArticleAction: contract(one(nonEmptyString), okSchema),

  fetchConversationsAction: contract(noArgs, z.array(conversationSchema)),
  fetchConversationRevisionsAction: contract(
    noArgs,
    object({
      revisions: z.array(
        object({
          conv_id: nonEmptyString,
          revision: z.number().int().nonnegative(),
        }),
      ),
    }),
  ),
  markConversationReadAction: contract(
    one(
      conversationRefSchema
        .extend({ post_id: nonEmptyString, updatedAt: timestamp })
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
    object({ ok: z.literal(true), group: groupSchema }),
  ),
  leaveGroupAction: contract(one(nonEmptyString), okSchema),
  fetchGroupMembersAction: contract(
    one(nonEmptyString),
    object({
      members: z.array(groupMemberSchema),
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
    object({ posts: z.array(postSchema) }),
  ),
  fetchPostAction: contract(one(nonEmptyString), object({ post: postSchema })),
  createPostAction: contract(
    one(
      object({
        content: z.union([z.string(), createPostPayloadSchema]).optional(),
        conv_id: nonEmptyString,
        reply_to: z.string().optional(),
      }),
    ),
    object({ post: postSchema }),
  ),
  updatePostAction: contract(
    one(object({ postId: nonEmptyString, text: z.string() })),
    object({ post: postSchema }),
  ),
  deletePostAction: contract(one(nonEmptyString), object({ post: postSchema })),

  fetchReaderConfigAction: contract(noArgs, blobReaderConfigSchema),
  updateReaderConfigAction: contract(
    one(
      object({
        grayscale: z.boolean().optional(),
        zoom: z.number().finite().optional(),
      }),
    ),
    blobReaderConfigSchema,
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
    object({ post: postSchema }),
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
  ) => Promise<CheckedActionResult<ActionData<K>>>;
};

export type ActionHandlerFunctions = {
  [K in ActionName]: (...args: ActionArgs<K>) => Promise<ActionData<K>>;
};
