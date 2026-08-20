import type {
  AppDisableState,
  ArticleWithMeta,
  ConversationEntity,
  PostEntity,
  User,
  UserMetadata,
} from "@/shared/types/api";
import type {
  Article,
  Conversation,
  Post,
} from "@/client/interact/presentation";
import { dmConvId, groupConvId, parseConvId } from "@/shared/conversations/id";
import { requestResult, runTransaction } from "./idb";
import { STORES, GLOBAL_KEYS, type StoreName } from "./schema";
import type {
  AccessRow,
  ArticleAccessRow,
  ArticleMembership,
  ArticleUserStateRow,
  ConversationAccessRow,
  ConversationUserStateRow,
  GroupMembersAccessRow,
  MeRow,
  MeStateRow,
  ObjectiveArticle,
  ObjectiveUser,
  PostCoverage,
  RetentionRow,
  StoredArticleSegment,
  StoredDm,
  StoredGroup,
  StoredPost,
} from "./model";
import { extentFiles } from "./files";
import { FileIds } from "./fileIds";
import {
  imageIdsFromPosts,
  deletePostImageExtents,
  postEntityForRevisionCompare,
} from "./postImages";
import {
  articleListRootMemberships,
  connectPostPage,
  mergeArticleListMemberships,
  mergeCursorCoverage,
  nextPostWindowCoverage,
  postCoverageAfterPrefixDelete,
  postIsInsidePublishedWindow,
  shouldExtendPostCoverage,
  type ContinuousCoverage,
} from "@/client/repo/coverage";
import { Assignments as Values, statePending, type Assignment } from "@/client/repo/assignment";
import { keepWatermarkProposal } from "@/client/repo/watermark";
import { assertImmutableEntity } from "@/client/repo/immutable";
import {
  decideRevisionedWrite,
  mergeRevisionedIdentity,
} from "@/client/repo/revision";
import {
  ARTICLE_RETENTION_DAYS,
  CONVERSATION_RETENTION_DAYS,
  conversationRetentionCutoff,
  type ArticleDownloadPolicy,
  type ConversationDownloadPolicy,
} from "./retentionPolicy";

export {
  ARTICLE_RETENTION_DAYS,
  CONVERSATION_RETENTION_DAYS,
  conversationRetentionCutoff,
  type ArticleDownloadPolicy,
  type ConversationDownloadPolicy,
};

const MAX_RECORD_DELETES_PER_TRANSACTION = 64;

export interface DraftVersion {
  content: string;
  updatedAt: number;
  syncedAt: number | null;
}

export interface VersionedValue<T> {
  value: T;
  purpose: string;
  updatedAt: number;
  syncedAt: number | null;
}

export interface ConversationReadValue {
  postId: string | null;
  sequence: number;
}

export interface ReadingProgressVersion {
  offset: number;
  updatedAt: number;
  synced: boolean;
}

async function mergeUserMetadata(
  store: IDBObjectStore,
  incoming: UserMetadata,
): Promise<void> {
  const current = (await requestResult(store.get(incoming.id))) as
    | ObjectiveUser
    | undefined;
  const next = mergeRevisionedIdentity({
    current,
    incoming,
    sameContent:
      !current ||
      (current.handle === incoming.handle &&
        current.username === incoming.username),
    identity: incoming.id,
  });
  if (next === "keep") return;
  store.put(next satisfies ObjectiveUser);
}

class Policies {
  static conversation(value: unknown): ConversationDownloadPolicy {
    return value === "week" || value === "half-year" ? value : "auto";
  }

  static article(value: unknown): ArticleDownloadPolicy {
    if (!value || typeof value !== "object") return { mode: "auto" };
    const candidate = value as Partial<{
      mode: string;
      days: number;
      expiresAt: number;
    }>;
    if (
      candidate.mode !== "retained" ||
      !ARTICLE_RETENTION_DAYS.includes(candidate.days as 1 | 7 | 180) ||
      typeof candidate.expiresAt !== "number"
    ) {
      return { mode: "auto" };
    }
    return {
      mode: "retained",
      days: candidate.days as 1 | 7 | 180,
      expiresAt: candidate.expiresAt,
    };
  }
}

async function postCoverage(convId: string): Promise<PostCoverage | null> {
  return runTransaction(STORES.SYNC, "readonly", async (tx) => {
    const row = await requestResult(
      tx.objectStore(STORES.SYNC).get(`posts:${convId}`),
    );
    return (row as PostCoverage | undefined) ?? null;
  });
}

async function clearConversationPostWindow(convId: string): Promise<void> {
  const removed = await runTransaction(
    [STORES.POSTS, STORES.SYNC],
    "readwrite",
    async (tx) => {
      const keys = await requestResult(
        tx
          .objectStore(STORES.POSTS)
          .index("by-conversation-sequence")
          .getAllKeys(
            IDBKeyRange.bound([convId, 0], [convId, Number.MAX_SAFE_INTEGER]),
          ),
      );
      const posts = tx.objectStore(STORES.POSTS);
      const rows: StoredPost[] = [];
      for (const key of keys) {
        const row = (await requestResult(posts.get(key))) as StoredPost | undefined;
        if (row) rows.push(row);
        posts.delete(key);
      }
      tx.objectStore(STORES.SYNC).delete(`posts:${convId}`);
      return imageIdsFromPosts(rows);
    },
  );
  await deletePostImageExtents(removed);
}

async function deleteConversationPostPrefix(
  convId: string,
  count: number,
  updatedAt = Date.now(),
  allowProtected = false,
): Promise<{ bytes: number; deletedProtected: boolean }> {
  let remaining = count;
  let bytes = 0;
  let deletedProtected = false;
  const removedImageIds: string[] = [];
  while (remaining > 0) {
    let deleted = 0;
    await runTransaction(
      [STORES.POSTS, STORES.SYNC, STORES.SAVE],
      "readwrite",
      async (tx) => {
        const postStore = tx.objectStore(STORES.POSTS);
        const orderedRows = (await requestResult(
          postStore
            .index("by-conversation-sequence")
            .getAll(
              IDBKeyRange.bound([convId, 0], [convId, Number.MAX_SAFE_INTEGER]),
            ),
        )) as StoredPost[];
        const claims = (await requestResult(
          tx
            .objectStore(STORES.SAVE)
            .index("by-resource")
            .getAll(IDBKeyRange.only(["conversation", convId])),
        )) as RetentionRow[];
        const retentionDays = claims.reduce(
          (days, claim) =>
            Math.max(
              days,
              CONVERSATION_RETENTION_DAYS[Policies.conversation(claim.mode)],
            ),
          0,
        );
        const cutoff = retentionDays
          ? Date.now() - retentionDays * 86_400_000
          : null;
        const batch: StoredPost[] = [];
        for (const row of orderedRows) {
          if (
            batch.length >=
            Math.min(remaining, MAX_RECORD_DELETES_PER_TRANSACTION)
          ) {
            break;
          }
          const protectedByClaim =
            cutoff !== null && Date.parse(row.created_at) >= cutoff;
          if (protectedByClaim && !allowProtected) break;
          batch.push(row);
          if (protectedByClaim) deletedProtected = true;
        }
        const retained = orderedRows.slice(batch.length);
        deleted = batch.length;
        for (const row of batch) {
          postStore.delete(row.id);
          bytes += row.size;
        }
        removedImageIds.push(...imageIdsFromPosts(batch));

        const syncStore = tx.objectStore(STORES.SYNC);
        const scope = `posts:${convId}`;
        const coverage = (await requestResult(syncStore.get(scope))) as
          PostCoverage | undefined;
        const next = postCoverageAfterPrefixDelete(coverage, retained);
        if (next === "unchanged") return;
        if (next === "delete") {
          // Published coverage is a proof about a non-empty contiguous range.
          // Keeping an empty range would allow revisions to advance while rows
          // are silently discarded.
          syncStore.delete(scope);
          return;
        }
        syncStore.put({ ...next, updated_at: updatedAt });
      },
    );
    if (!deleted) break;
    remaining -= deleted;
  }
  await deletePostImageExtents(removedImageIds);
  return { bytes, deletedProtected };
}

function conversationIdForActor(
  ref: Pick<Conversation, "type" | "id"> &
    Partial<Pick<Conversation, "conv_id">>,
  meId: string,
): string {
  if (ref.conv_id) return ref.conv_id;
  return ref.type === "group" ? groupConvId(ref.id) : dmConvId(meId, ref.id);
}

function defaultConversationState(
  meId: string,
  convId: string,
): ConversationUserStateRow {
  return {
    me_id: meId,
    conv_id: convId,
    read: Values.assignment({ post_id: null, sequence: 0 }),
    pinned: Values.assignment(false),
    muted: Values.assignment(false),
    draft: Values.assignment(""),
    unread: {
      first_post_id: null,
      count: 0,
      snapshot_revision: 0,
    },
    pending: 0,
  };
}

function defaultArticleState(
  meId: string,
  articleId: string,
): ArticleUserStateRow {
  return {
    me_id: meId,
    article_id: articleId,
    bookmark: Values.assignment(false),
    resume: Values.assignment(0),
    furthest: Values.assignment(0),
    total_read_seconds: 0,
    last_read_at: null,
    pending: 0,
  };
}

function splitArticle(entry: ArticleWithMeta): {
  entity: ObjectiveArticle;
  state: {
    bookmark: { value: boolean; updatedAt: number };
    resume: { value: number; updatedAt: number };
    totalReadSeconds: number;
    lastReadAt: string | null;
  };
} {
  const core: ObjectiveArticle["value"] = {
    id: entry.id,
    user_id: entry.user_id,
    group_id: entry.group_id,
    title: entry.title,
    provider: entry.provider,
    content_kind: entry.content_kind,
    mime_type: entry.mime_type,
    file_size: entry.file_size,
    original_filename: entry.original_filename,
    created_at: entry.created_at,
    content_length: entry.content_length,
  };
  return {
    entity: {
      id: entry.id,
      value: core,
      group_id: entry.group_id,
      created_at: entry.created_at,
      size: Values.size(core),
      touched_at: Date.now(),
      eviction_tier: 0,
    },
    state: {
      bookmark: {
        value: entry.is_bookmarked,
        updatedAt: entry.bookmark_updated_at_ms,
      },
      resume: {
        value: entry.current_offset,
        updatedAt: entry.current_offset_updated_at,
      },
      totalReadSeconds: entry.total_read_seconds ?? 0,
      lastReadAt: entry.last_read_at ?? null,
    },
  };
}

async function accessRows(
  meId: string,
  kind: "conversation" | "article",
): Promise<AccessRow[]> {
  return runTransaction(STORES.ME_ACCESS, "readonly", async (tx) => {
    const rows = await requestResult(
      tx
        .objectStore(STORES.ME_ACCESS)
        .index("by-me-kind")
        .getAll(IDBKeyRange.only([meId, kind])),
    );
    return rows as AccessRow[];
  });
}

async function getConversationState(
  meId: string,
  convId: string,
): Promise<ConversationUserStateRow> {
  return runTransaction(STORES.ME_CONV_STATE, "readonly", async (tx) => {
    const value = await requestResult(
      tx.objectStore(STORES.ME_CONV_STATE).get([meId, convId]),
    );
    return (
      (value as ConversationUserStateRow | undefined) ??
      defaultConversationState(meId, convId)
    );
  });
}

async function getArticleState(
  meId: string,
  articleId: string,
): Promise<ArticleUserStateRow> {
  return runTransaction(STORES.ME_ARTICLE_STATE, "readonly", async (tx) => {
    const value = await requestResult(
      tx.objectStore(STORES.ME_ARTICLE_STATE).get([meId, articleId]),
    );
    return (
      (value as ArticleUserStateRow | undefined) ??
      defaultArticleState(meId, articleId)
    );
  });
}

async function materializeConversation(
  access: ConversationAccessRow,
): Promise<Conversation | null> {
  const meId = access.me_id;
  const state = await getConversationState(meId, access.object_id);
  const read = Values.resolved(state.read);
  const pinned = Values.resolved(state.pinned);
  const muted = Values.resolved(state.muted);
  if (access.type === "group") {
    const row = await runTransaction(STORES.GROUPS, "readonly", (tx) =>
      requestResult(tx.objectStore(STORES.GROUPS).get(access.target_id)),
    );
    if (!row) return null;
    const group = row as StoredGroup;
    return {
      ...group,
      type: "group",
      group_type: group.group_type,
      id: group.id,
      last_read_post_id: read.value.post_id,
      last_read_post_sequence: read.value.sequence,
      read_updated_at_ms: read.updatedAt,
      first_unread_post_id: state.unread.first_post_id,
      unread_count: state.unread.count,
      pinned: pinned.value ? 1 : 0,
      pinned_updated_at_ms: pinned.updatedAt,
      muted: muted.value ? 1 : 0,
      muted_updated_at_ms: muted.updatedAt,
      can_post: access.capabilities.can_post,
      can_leave: access.capabilities.can_leave,
    };
  }

  const row = await runTransaction(STORES.DMS, "readonly", (tx) =>
    requestResult(tx.objectStore(STORES.DMS).get(access.object_id)),
  );
  if (!row) return null;
  const dm = row as StoredDm;
  const peer = await runTransaction(STORES.USERS, "readonly", (tx) =>
    requestResult(tx.objectStore(STORES.USERS).get(access.target_id)),
  );
  const user = peer as ObjectiveUser | undefined;
  return {
    conv_id: dm.conv_id,
    revision: dm.revision,
    type: "dm",
    group_type: null,
    id: access.target_id,
    handle: user?.handle ?? null,
    name: user?.username ?? "已注销",
    has_password: 0,
    members_hidden: 0,
    admin_only: 0,
    no_leave: 0,
    last_message: dm.last_message,
    last_at: dm.last_at,
    last_read_post_id: read.value.post_id,
    last_read_post_sequence: read.value.sequence,
    read_updated_at_ms: read.updatedAt,
    first_unread_post_id: state.unread.first_post_id,
    unread_count: state.unread.count,
    pinned: pinned.value ? 1 : 0,
    pinned_updated_at_ms: pinned.updatedAt,
    muted: muted.value ? 1 : 0,
    muted_updated_at_ms: muted.updatedAt,
    can_post: access.capabilities.can_post,
    can_leave: access.capabilities.can_leave,
  };
}

function sortConversations(entries: Conversation[]): Conversation[] {
  return entries.sort((left, right) => {
    if (!!left.pinned !== !!right.pinned) return right.pinned - left.pinned;
    if (left.last_at && right.last_at) {
      return right.last_at.localeCompare(left.last_at);
    }
    if (left.last_at) return -1;
    if (right.last_at) return 1;
    return left.name.localeCompare(right.name);
  });
}

async function upsertConversationInTransaction(
  tx: IDBTransaction,
  meId: string,
  entry: ConversationEntity,
): Promise<void> {
  const now = Date.now();
  const parsed = parseConvId(entry.conv_id);
  if (!parsed) throw new Error(`Invalid conversation id: ${entry.conv_id}`);
  if (entry.type === "group" && parsed.type === "group") {
    tx.objectStore(STORES.GROUPS).put({
      id: entry.id,
      conv_id: entry.conv_id,
      revision: entry.revision,
      handle: entry.handle ?? entry.id,
      name: entry.name,
      group_type: entry.group_type ?? "normal",
      has_password: entry.has_password,
      members_hidden: entry.members_hidden,
      admin_only: entry.admin_only,
      no_leave: entry.no_leave,
      last_message: entry.last_message,
      last_at: entry.last_at,
      touched_at: now,
    } satisfies StoredGroup);
  } else if (entry.type === "dm" && parsed.type === "dm") {
    tx.objectStore(STORES.DMS).put({
      conv_id: entry.conv_id,
      revision: entry.revision,
      peer_a: parsed.peerA,
      peer_b: parsed.peerB,
      last_message: entry.last_message,
      last_at: entry.last_at,
      touched_at: now,
    } satisfies StoredDm);
  } else {
    throw new Error(`Conversation type disagrees with id: ${entry.conv_id}`);
  }

  const access: ConversationAccessRow = {
    me_id: meId,
    kind: "conversation",
    object_id: entry.conv_id,
    type: entry.type,
    target_id: entry.id,
    capabilities: {
      can_post: entry.can_post,
      can_leave: entry.can_leave,
    },
    snapshot_at: now,
  };
  tx.objectStore(STORES.ME_ACCESS).put(access);

  const stateStore = tx.objectStore(STORES.ME_CONV_STATE);
  const current =
    ((await requestResult(stateStore.get([meId, entry.conv_id]))) as
      ConversationUserStateRow | undefined) ??
    defaultConversationState(meId, entry.conv_id);
  const next: ConversationUserStateRow = {
    ...current,
    read: Values.reconcile(current.read, {
      value: {
        post_id: entry.last_read_post_id,
        sequence: entry.last_read_post_sequence,
      },
      updatedAt: entry.read_updated_at_ms,
    }),
    pinned: Values.reconcile(current.pinned, {
      value: !!entry.pinned,
      updatedAt: entry.pinned_updated_at_ms,
    }),
    muted: Values.reconcile(current.muted, {
      value: !!entry.muted,
      updatedAt: entry.muted_updated_at_ms,
    }),
    unread: {
      first_post_id: entry.first_unread_post_id,
      count: entry.unread_count,
      snapshot_revision: entry.revision,
    },
  };
  next.pending = statePending(next);
  stateStore.put(next);
}

async function upsertArticle(
  meId: string,
  entry: ArticleWithMeta,
  membership: ArticleAccessRow["memberships"][number],
): Promise<void> {
  await runTransaction(
    [STORES.ARTICLES, STORES.USERS, STORES.ME_ACCESS, STORES.ME_ARTICLE_STATE],
    "readwrite",
    async (tx) => {
      const { entity, state } = splitArticle(entry);
      const articleStore = tx.objectStore(STORES.ARTICLES);
      // The server enforces Article immutability. Re-publishing the same entity
      // is idempotent and avoids an unnecessary read-before-write race.
      articleStore.put(entity);
      const accessStore = tx.objectStore(STORES.ME_ACCESS);
      const currentAccess = (await requestResult(
        accessStore.get([meId, "article", entry.id]),
      )) as ArticleAccessRow | undefined;
      const memberships = mergeArticleListMemberships(
        currentAccess?.memberships,
        membership,
      );
      accessStore.put({
        me_id: meId,
        kind: "article",
        object_id: entry.id,
        memberships,
        snapshot_at: Date.now(),
      } satisfies ArticleAccessRow);

      const stateStore = tx.objectStore(STORES.ME_ARTICLE_STATE);
      const current =
        ((await requestResult(stateStore.get([meId, entry.id]))) as
          ArticleUserStateRow | undefined) ??
        defaultArticleState(meId, entry.id);
      const next: ArticleUserStateRow = {
        ...current,
        bookmark: Values.reconcile(current.bookmark, state.bookmark),
        resume: Values.reconcile(current.resume, state.resume),
        total_read_seconds: state.totalReadSeconds,
        last_read_at: state.lastReadAt,
      };
      next.pending = statePending(next);
      stateStore.put(next);
    },
  );
}

async function materializeArticle(
  access: ArticleAccessRow,
): Promise<Article | null> {
  const article = await runTransaction(STORES.ARTICLES, "readonly", (tx) =>
    requestResult(tx.objectStore(STORES.ARTICLES).get(access.object_id)),
  );
  if (!article) return null;
  const row = article as ObjectiveArticle;
  if (row.group_id) {
    const groupAccess = await runTransaction(
      STORES.ME_ACCESS,
      "readonly",
      (tx) =>
        requestResult(
          tx
            .objectStore(STORES.ME_ACCESS)
            .get([access.me_id, "conversation", groupConvId(row.group_id!)]),
        ),
    );
    if (!groupAccess) return null;
  }
  const state = await getArticleState(access.me_id, access.object_id);
  const author = row.value.user_id
    ? ((await runTransaction(STORES.USERS, "readonly", (tx) =>
        requestResult(tx.objectStore(STORES.USERS).get(row.value.user_id!)),
      )) as ObjectiveUser | undefined)
    : null;
  const bookmark = Values.resolved(state.bookmark);
  const resume = Values.resolved(state.resume);
  const membership = access.memberships[0];
  return {
    ...row.value,
    username: author?.username ?? null,
    handle: author?.handle ?? null,
    is_bookmarked: bookmark.value,
    bookmark_updated_at_ms: bookmark.updatedAt,
    current_offset: resume.value,
    current_offset_updated_at: resume.updatedAt,
    current_locator: null,
    total_read_seconds: state.total_read_seconds,
    last_read_at: state.last_read_at,
    ...(membership?.sort_at ? { list_sort_at: membership.sort_at } : {}),
  } as Article;
}

async function deviceConversationCutoff(
  convId: string,
): Promise<number | null> {
  const rows = await runTransaction(
    STORES.SAVE,
    "readonly",
    async (tx) =>
      (await requestResult(
        tx
          .objectStore(STORES.SAVE)
          .index("by-resource")
          .getAll(IDBKeyRange.only(["conversation", convId])),
      )) as RetentionRow[],
  );
  const days = rows.reduce(
    (maximum, row) =>
      Math.max(
        maximum,
        CONVERSATION_RETENTION_DAYS[Policies.conversation(row.mode)],
      ),
    0,
  );
  return days ? Date.now() - days * 86_400_000 : null;
}

export const sessionRepository = {
  konamiLockValue(row: MeRow): boolean {
    return Values.resolved(row.konami_lock).value;
  },

  async active(): Promise<MeRow | null> {
    return runTransaction(
      [STORES.GLOBALS, STORES.ME],
      "readonly",
      async (tx) => {
        const pointer = (await requestResult(
          tx.objectStore(STORES.GLOBALS).get(GLOBAL_KEYS.ACTIVE_ME),
        )) as { key: string; value: string | null } | undefined;
        if (!pointer?.value) return null;
        const row = await requestResult(
          tx.objectStore(STORES.ME).get(pointer.value),
        );
        return (row as MeRow | undefined) ?? null;
      },
    );
  },

  async save(user: User, token: string): Promise<void> {
    await runTransaction(
      [STORES.GLOBALS, STORES.ME],
      "readwrite",
      async (tx) => {
        const meStore = tx.objectStore(STORES.ME);
        const rows = (await requestResult(meStore.getAll())) as MeRow[];
        for (const previous of rows) {
          if (previous.me_id !== user.id && previous.session_token) {
            meStore.put({ ...previous, session_token: null });
          }
        }
        const previous = rows.find((entry) => entry.me_id === user.id);
        const row: MeRow = {
          me_id: user.id,
          user,
          session_token: token,
          konami_lock: previous?.konami_lock ?? Values.assignment(false),
          app_disable: previous?.app_disable ?? {
            disabled: false,
            reason: null,
          },
          system_locked: previous?.system_locked ?? false,
          updated_at: Date.now(),
        };
        meStore.put(row);
        tx.objectStore(STORES.GLOBALS).put({
          key: GLOBAL_KEYS.ACTIVE_ME,
          value: user.id,
        });
      },
    );
  },

  async saveServerState(
    user: User,
    state: {
      konami_locked: boolean;
      app_disable: AppDisableState;
      system_locked: boolean;
    },
  ): Promise<void> {
    await runTransaction(
      [STORES.GLOBALS, STORES.ME],
      "readwrite",
      async (tx) => {
        const globals = tx.objectStore(STORES.GLOBALS);
        const pointer = (await requestResult(
          globals.get(GLOBAL_KEYS.ACTIVE_ME),
        )) as { key: string; value: string | null } | undefined;
        if (pointer?.value !== user.id) return;

        const meStore = tx.objectStore(STORES.ME);
        const current = (await requestResult(meStore.get(user.id))) as
          MeRow | undefined;
        if (!current?.session_token) return;
        const proposal = current.konami_lock.proposal;
        const konamiLock: Assignment<boolean> = proposal
          ? state.konami_locked === proposal.value
            ? {
                base: {
                  value: state.konami_locked,
                  updated_at: proposal.updated_at,
                },
                proposal: null,
              }
            : {
                base: {
                  value: state.konami_locked,
                  updated_at: Math.min(Date.now(), proposal.updated_at - 1),
                },
                proposal,
              }
          : Values.assignment(state.konami_locked, Date.now());
        meStore.put({
          ...current,
          user,
          konami_lock: konamiLock,
          app_disable: state.app_disable,
          system_locked: state.system_locked,
          updated_at: Date.now(),
        } satisfies MeRow);
      },
    );
  },

  async proposeKonamiLock(meId: string, konamiLocked: boolean): Promise<void> {
    await runTransaction(
      [STORES.GLOBALS, STORES.ME],
      "readwrite",
      async (tx) => {
        const pointer = (await requestResult(
          tx.objectStore(STORES.GLOBALS).get(GLOBAL_KEYS.ACTIVE_ME),
        )) as { key: string; value: string | null } | undefined;
        if (pointer?.value !== meId) return;

        const store = tx.objectStore(STORES.ME);
        const latest = (await requestResult(store.get(meId))) as
          MeRow | undefined;
        if (!latest?.session_token) return;
        store.put({
          ...latest,
          konami_lock: Values.propose(latest.konami_lock, konamiLocked),
          updated_at: Date.now(),
        } satisfies MeRow);
      },
    );
  },

  async acknowledgeKonamiLock(
    meId: string,
    operationId: string,
    konamiLocked: boolean,
  ): Promise<void> {
    await runTransaction(STORES.ME, "readwrite", async (tx) => {
      const store = tx.objectStore(STORES.ME);
      const current = (await requestResult(store.get(meId))) as
        MeRow | undefined;
      const proposal = current?.konami_lock.proposal;
      if (!current || proposal?.operation_id !== operationId) return;
      store.put({
        ...current,
        konami_lock: {
          base: {
            value: konamiLocked,
            updated_at: proposal.updated_at,
          },
          proposal: null,
        },
        updated_at: Date.now(),
      } satisfies MeRow);
    });
  },

  async abandonKonamiLockProposal(
    meId: string,
    proposedValue: boolean,
  ): Promise<void> {
    await runTransaction(STORES.ME, "readwrite", async (tx) => {
      const store = tx.objectStore(STORES.ME);
      const current = (await requestResult(store.get(meId))) as
        MeRow | undefined;
      if (current?.konami_lock.proposal?.value !== proposedValue) return;
      store.put({
        ...current,
        konami_lock: { ...current.konami_lock, proposal: null },
        updated_at: Date.now(),
      } satisfies MeRow);
    });
  },

  async pendingKonamiLock(): Promise<{
    meId: string;
    value: boolean;
    operationId: string;
  } | null> {
    const current = await this.active();
    const proposal = current?.konami_lock.proposal;
    if (!current?.session_token || !proposal) return null;
    return {
      meId: current.me_id,
      value: proposal.value,
      operationId: proposal.operation_id,
    };
  },

  async clear(): Promise<void> {
    const current = await this.active();
    await runTransaction([STORES.GLOBALS, STORES.ME], "readwrite", (tx) => {
      tx.objectStore(STORES.GLOBALS).put({
        key: GLOBAL_KEYS.ACTIVE_ME,
        value: null,
      });
      if (current) {
        tx.objectStore(STORES.ME).put({ ...current, session_token: null });
      }
    });
  },
};

function createOfflineRepository(userScope: string) {
  const actorId = () => userScope;
  const conversationId = (
    ref: Pick<Conversation, "type" | "id"> &
      Partial<Pick<Conversation, "conv_id">>,
  ) => conversationIdForActor(ref, userScope);

  const repository = {
    async getVersionedValue<T>(namespace: string, id: string) {
      const key = `${namespace}:${id}`;
      return runTransaction(STORES.ME_STATE, "readonly", async (tx) => {
        const row = (await requestResult(
          tx.objectStore(STORES.ME_STATE).get([actorId(), key]),
        )) as MeStateRow<T> | undefined;
        if (!row) return null;
        const resolved = Values.resolved(row.assignment);
        return {
          value: resolved.value,
          purpose: key,
          updatedAt: resolved.updatedAt,
          syncedAt: resolved.pending ? null : resolved.updatedAt,
        } satisfies VersionedValue<T>;
      });
    },

    async setVersionedValue<T>(
      namespace: string,
      id: string,
      value: T,
      options?: { updatedAt?: number; synced?: boolean },
    ) {
      const meId = actorId();
      const key = `${namespace}:${id}`;
      return runTransaction(STORES.ME_STATE, "readwrite", async (tx) => {
        const store = tx.objectStore(STORES.ME_STATE);
        const current = (await requestResult(store.get([meId, key]))) as
          MeStateRow<T> | undefined;
        const assignment = options?.synced
          ? Values.reconcile(current?.assignment ?? null, {
              value,
              updatedAt: options.updatedAt ?? 0,
            })
          : Values.propose(
              current?.assignment ?? null,
              value,
              options?.updatedAt,
            );
        const row: MeStateRow<T> = {
          me_id: meId,
          key,
          assignment,
          pending: assignment.proposal ? 1 : 0,
        };
        store.put(row);
        const resolved = Values.resolved(assignment);
        return {
          value: resolved.value,
          purpose: key,
          updatedAt: resolved.updatedAt,
          syncedAt: resolved.pending ? null : resolved.updatedAt,
        } satisfies VersionedValue<T>;
      });
    },

    async reconcileVersionedValue<T>(
      namespace: string,
      id: string,
      remote: { value: T; updatedAt: number },
    ) {
      return this.setVersionedValue(namespace, id, remote.value, {
        updatedAt: remote.updatedAt,
        synced: true,
      });
    },

    async getPendingVersionedValues<T>(namespace: string) {
      const prefix = `${namespace}:`;
      return runTransaction(STORES.ME_STATE, "readonly", async (tx) => {
        const rows = (await requestResult(
          tx
            .objectStore(STORES.ME_STATE)
            .index("by-pending")
            .getAll(IDBKeyRange.only([actorId(), 1])),
        )) as MeStateRow<T>[];
        return rows
          .filter((row) => row.key.startsWith(prefix))
          .map((row) => {
            const resolved = Values.resolved(row.assignment);
            return {
              id: row.key.slice(prefix.length),
              version: {
                value: resolved.value,
                purpose: row.key,
                updatedAt: resolved.updatedAt,
                syncedAt: null,
              } satisfies VersionedValue<T>,
            };
          });
      });
    },

    async saveConversations(
      entries: ConversationEntity[],
      users: UserMetadata[],
    ): Promise<void> {
      const meId = actorId();
      const stores: StoreName[] = [
        STORES.GROUPS,
        STORES.DMS,
        STORES.USERS,
        STORES.ME_ACCESS,
        STORES.ME_CONV_STATE,
        STORES.SYNC,
      ];
      await runTransaction(stores, "readwrite", async (tx) => {
        const accessStore = tx.objectStore(STORES.ME_ACCESS);
        const oldKeys = await requestResult(
          accessStore
            .index("by-me-kind")
            .getAllKeys(IDBKeyRange.only([meId, "conversation"])),
        );
        for (const key of oldKeys) accessStore.delete(key);
        const userStore = tx.objectStore(STORES.USERS);
        for (const user of users) await mergeUserMetadata(userStore, user);
        for (const entry of entries) {
          await upsertConversationInTransaction(tx, meId, entry);
        }
        tx.objectStore(STORES.SYNC).put({
          scope: `me:${meId}:conversations`,
          kind: "conversation-snapshot",
          me_id: meId,
          complete: true,
          updated_at: Date.now(),
        });
      });
    },

    async getConversations(): Promise<Conversation[]> {
      const rows = (await accessRows(
        actorId(),
        "conversation",
      )) as ConversationAccessRow[];
      const entries = await Promise.all(rows.map(materializeConversation));
      return sortConversations(
        entries.filter((value): value is Conversation => !!value),
      );
    },

    async upsertConversation(
      entry: ConversationEntity,
      users: UserMetadata[],
    ): Promise<void> {
      const meId = actorId();
      await runTransaction(
        [
          STORES.GROUPS,
          STORES.DMS,
          STORES.USERS,
          STORES.ME_ACCESS,
          STORES.ME_CONV_STATE,
        ],
        "readwrite",
        async (tx) => {
          const userStore = tx.objectStore(STORES.USERS);
          for (const user of users) await mergeUserMetadata(userStore, user);
          return upsertConversationInTransaction(tx, meId, entry);
        },
      );
    },

    async removeConversation(
      ref: Pick<Conversation, "type" | "id">,
    ): Promise<void> {
      const convId = conversationId(ref);
      await runTransaction(
        [STORES.ME_ACCESS, STORES.ME_CONV_STATE],
        "readwrite",
        async (tx) => {
          tx.objectStore(STORES.ME_ACCESS).delete([
            actorId(),
            "conversation",
            convId,
          ]);
          tx.objectStore(STORES.ME_CONV_STATE).delete([actorId(), convId]);
        },
      );
    },

    async saveGroupMembers(
      groupId: string,
      payload: GroupMembersAccessRow["snapshot"] & {
        users: UserMetadata[];
      },
    ): Promise<void> {
      await runTransaction(
        [STORES.ME_ACCESS, STORES.USERS],
        "readwrite",
        async (tx) => {
          const { users: userMetadata, ...snapshot } = payload;
          tx.objectStore(STORES.ME_ACCESS).put({
            me_id: actorId(),
            kind: "group-members",
            object_id: groupId,
            snapshot,
            snapshot_at: Date.now(),
          } satisfies GroupMembersAccessRow);
          const users = tx.objectStore(STORES.USERS);
          for (const user of userMetadata)
            await mergeUserMetadata(users, user);
        },
      );
    },

    async getGroupMembers(groupId: string) {
      return runTransaction(
        [STORES.ME_ACCESS, STORES.USERS],
        "readonly",
        async (tx) => {
          const conversation = await requestResult(
            tx
              .objectStore(STORES.ME_ACCESS)
              .get([actorId(), "conversation", groupConvId(groupId)]),
          );
          if (!conversation) return null;
          const row = await requestResult(
            tx
              .objectStore(STORES.ME_ACCESS)
              .get([actorId(), "group-members", groupId]),
          );
          const snapshot = (row as GroupMembersAccessRow | undefined)?.snapshot;
          if (!snapshot) return null;
          const userStore = tx.objectStore(STORES.USERS);
          const members = await Promise.all(
            snapshot.members.map(async (member) => {
              const user = (await requestResult(
                userStore.get(member.id),
              )) as ObjectiveUser | undefined;
              return {
                ...member,
                handle: user?.handle ?? null,
                username: user?.username ?? "已注销",
              };
            }),
          );
          return { ...snapshot, members };
        },
      );
    },

    async setConversationFlag(
      ref: Pick<Conversation, "type" | "id">,
      field: "pinned" | "muted",
      value: boolean,
    ): Promise<VersionedValue<boolean>> {
      const meId = actorId();
      const convId = conversationId(ref);
      return runTransaction(STORES.ME_CONV_STATE, "readwrite", async (tx) => {
        const store = tx.objectStore(STORES.ME_CONV_STATE);
        const current =
          ((await requestResult(store.get([meId, convId]))) as
            ConversationUserStateRow | undefined) ??
          defaultConversationState(meId, convId);
        current[field] = Values.propose(current[field], value);
        current.pending = statePending(current);
        store.put(current);
        const resolved = Values.resolved(current[field]);
        return {
          value: resolved.value,
          purpose: `conversation:${convId}:${field}`,
          updatedAt: resolved.updatedAt,
          syncedAt: null,
        };
      });
    },

    async reconcileConversationFlag(
      ref: Pick<Conversation, "type" | "id">,
      field: "pinned" | "muted",
      remote: { value: boolean; updatedAt: number },
    ): Promise<VersionedValue<boolean>> {
      const meId = actorId();
      const convId = conversationId(ref);
      return runTransaction(STORES.ME_CONV_STATE, "readwrite", async (tx) => {
        const store = tx.objectStore(STORES.ME_CONV_STATE);
        const current =
          ((await requestResult(store.get([meId, convId]))) as
            ConversationUserStateRow | undefined) ??
          defaultConversationState(meId, convId);
        current[field] = Values.reconcile(current[field], remote);
        current.pending = statePending(current);
        store.put(current);
        const resolved = Values.resolved(current[field]);
        return {
          value: resolved.value,
          purpose: `conversation:${convId}:${field}`,
          updatedAt: resolved.updatedAt,
          syncedAt: resolved.pending ? null : resolved.updatedAt,
        };
      });
    },

    async getPendingConversationMutations() {
      const entries = await this.getConversations();
      const rows = await runTransaction(
        STORES.ME_CONV_STATE,
        "readonly",
        async (tx) =>
          (await requestResult(
            tx
              .objectStore(STORES.ME_CONV_STATE)
              .index("by-pending")
              .getAll(IDBKeyRange.only([actorId(), 1])),
          )) as ConversationUserStateRow[],
      );
      return rows.flatMap((row) => {
        const ref = entries.find((entry) => entry.conv_id === row.conv_id);
        if (!ref) return [];
        const pinned = Values.resolved(row.pinned);
        const muted = Values.resolved(row.muted);
        const read = Values.resolved(row.read);
        return [
          ...(pinned.pending
            ? [
                {
                  ref,
                  field: "pinned" as const,
                  value: pinned.value,
                  updatedAt: pinned.updatedAt,
                },
              ]
            : []),
          ...(muted.pending
            ? [
                {
                  ref,
                  field: "muted" as const,
                  value: muted.value,
                  updatedAt: muted.updatedAt,
                },
              ]
            : []),
          ...(read.pending
            ? [
                {
                  ref,
                  field: "read" as const,
                  value: {
                    postId: read.value.post_id,
                    sequence: read.value.sequence,
                  },
                  updatedAt: read.updatedAt,
                },
              ]
            : []),
        ];
      });
    },

    async getConversationReadVersion(
      ref: Pick<Conversation, "type" | "id">,
    ): Promise<VersionedValue<ConversationReadValue> | null> {
      const state = await getConversationState(actorId(), conversationId(ref));
      const read = Values.resolved(state.read);
      return {
        value: {
          postId: read.value.post_id,
          sequence: read.value.sequence,
        },
        purpose: "conversation-read",
        updatedAt: read.updatedAt,
        syncedAt: read.pending ? null : read.updatedAt,
      };
    },

    async setPendingConversationRead(
      ref: Pick<Conversation, "type" | "id">,
      postId: string,
      knownSequence = 0,
      offline = true,
    ) {
      const meId = actorId();
      const convId = conversationId(ref);
      return runTransaction(STORES.ME_CONV_STATE, "readwrite", async (tx) => {
        const store = tx.objectStore(STORES.ME_CONV_STATE);
        const current =
          ((await requestResult(store.get([meId, convId]))) as
            ConversationUserStateRow | undefined) ??
          defaultConversationState(meId, convId);
        const resolved = Values.resolved(current.read);
        if (
          offline &&
          knownSequence > 0 &&
          knownSequence <= resolved.value.sequence
        ) {
          return {
            version: {
              value: {
                postId: resolved.value.post_id,
                sequence: resolved.value.sequence,
              },
              purpose: "conversation-read",
              updatedAt: resolved.updatedAt,
              syncedAt: resolved.pending ? null : resolved.updatedAt,
            },
            changed: false,
          };
        }
        current.read = Values.propose(current.read, {
          post_id: postId,
          sequence: knownSequence,
        });
        if (knownSequence > 0) {
          current.unread = {
            first_post_id: null,
            count: 0,
            snapshot_revision: current.unread.snapshot_revision,
          };
        }
        current.pending = 1;
        store.put(current);
        const next = Values.resolved(current.read);
        return {
          version: {
            value: { postId, sequence: knownSequence },
            purpose: "conversation-read",
            updatedAt: next.updatedAt,
            syncedAt: null,
          },
          changed: true,
        };
      });
    },

    async reconcileConversationRead(
      ref: Pick<Conversation, "type" | "id">,
      remote: ConversationReadValue & { updatedAt: number },
      merge: "override" | "furthest" = "override",
    ) {
      const meId = actorId();
      const convId = conversationId(ref);
      return runTransaction(STORES.ME_CONV_STATE, "readwrite", async (tx) => {
        const store = tx.objectStore(STORES.ME_CONV_STATE);
        const current =
          ((await requestResult(store.get([meId, convId]))) as
            ConversationUserStateRow | undefined) ??
          defaultConversationState(meId, convId);
        const proposal = current.read.proposal;
        current.read = {
          base: {
            value: { post_id: remote.postId, sequence: remote.sequence },
            updated_at: remote.updatedAt,
          },
          proposal: keepWatermarkProposal({
            proposal,
            remoteUpdatedAt: remote.updatedAt,
            merge,
            proposalCursor: proposal?.value.sequence ?? 0,
            remoteCursor: remote.sequence,
          }),
        };
        current.pending = statePending(current);
        store.put(current);
        const resolved = Values.resolved(current.read);
        return {
          value: {
            postId: resolved.value.post_id,
            sequence: resolved.value.sequence,
          },
          purpose: "conversation-read",
          updatedAt: resolved.updatedAt,
          syncedAt: resolved.pending ? null : resolved.updatedAt,
        } satisfies VersionedValue<ConversationReadValue>;
      });
    },

    async savePosts(
      ref: Pick<Conversation, "type" | "id"> &
        Partial<Pick<Conversation, "conv_id">>,
      incoming: PostEntity[],
      options: {
        extendCoverage?: boolean;
        liveAppend?: boolean;
        reachedOldest?: boolean;
        reachedNewest?: boolean;
      } = {},
    ): Promise<void> {
      const convId = conversationId(ref);
      if (!incoming.length) return;
      await runTransaction(
        [STORES.POSTS, STORES.SYNC],
        "readwrite",
        async (tx) => {
          const store = tx.objectStore(STORES.POSTS);
          const syncStore = tx.objectStore(STORES.SYNC);
          const scope = `posts:${convId}`;
          const current = (await requestResult(syncStore.get(scope))) as
            PostCoverage | undefined;
          const extendCoverage = shouldExtendPostCoverage({
            current,
            extendCoverage: options.extendCoverage,
            liveAppend: options.liveAppend,
            incomingSequences: incoming.map((post) => post.sequence),
          });
          const written: Array<{ id: string; sequence: number }> = [];
          for (const post of incoming) {
            const entity = post;
            if (
              !Number.isSafeInteger(post.sequence) ||
              (post.sequence ?? 0) <= 0
            ) {
              throw new Error(
                `Post ${post.id} is missing its required sequence`,
              );
            }
            const previous = (await requestResult(store.get(post.id))) as
              StoredPost | undefined;
            if (
              !extendCoverage &&
              !previous &&
              !postIsInsidePublishedWindow(current, post.sequence)
            ) {
              continue;
            }
            if (
              decideRevisionedWrite({
                previous,
                incoming: post,
                sameContent: previous
                  ? Values.equal(
                      {
                        ...postEntityForRevisionCompare(previous),
                        size: 0,
                        touched_at: 0,
                        eviction_tier: 0,
                      },
                      {
                        ...postEntityForRevisionCompare(entity),
                        size: 0,
                        touched_at: 0,
                        eviction_tier: 0,
                      },
                    )
                  : true,
                identity: post.id,
                collisionLabel: "Post revision collision",
              }) === "skip"
            ) {
              continue;
            }
            const row: StoredPost = {
              ...entity,
              sequence: post.sequence!,
              size: Values.size(entity),
              touched_at: Date.now(),
              eviction_tier: 0,
            };
            store.put(row);
            written.push({ id: row.id, sequence: row.sequence });
          }
          if (!extendCoverage) return;
          const next = nextPostWindowCoverage({
            current,
            written,
            reachedOldest: options.reachedOldest,
            reachedNewest: options.reachedNewest,
          });
          if (!next) return;
          syncStore.put({
            scope,
            kind: "posts",
            conv_id: convId,
            known_revision: next.known_revision,
            revision_sum: next.revision_sum,
            oldest: next.oldest,
            newest: next.newest,
            reached_oldest: next.reached_oldest,
            reached_newest: next.reached_newest,
            updated_at: Date.now(),
          } satisfies PostCoverage);
        },
      );
      await this.trimConversationPosts(ref);
    },

    async saveUserMetadata(users: UserMetadata[]): Promise<void> {
      if (!users.length) return;
      await runTransaction(STORES.USERS, "readwrite", async (tx) => {
        const store = tx.objectStore(STORES.USERS);
        for (const user of users) await mergeUserMetadata(store, user);
      });
    },

    async applyPostVersion(
      post: PostEntity,
      liveAppend = false,
    ): Promise<void> {
      const parsed = parseConvId(post.conv_id);
      if (!parsed) return;
      const ref =
        parsed.type === "group"
          ? {
              type: "group" as const,
              id: parsed.groupId,
              conv_id: post.conv_id,
            }
          : {
              type: "dm" as const,
              id: parsed.peerA === actorId() ? parsed.peerB : parsed.peerA,
              conv_id: post.conv_id,
            };
      await this.savePosts(ref, [post], {
        liveAppend,
        reachedNewest: liveAppend,
      });
    },

    async reconcilePostPage(
      ref: Pick<Conversation, "type" | "id"> &
        Partial<Pick<Conversation, "conv_id">>,
      incoming: PostEntity[],
      page: {
        beforeId?: string;
        afterId?: string;
        exhausted: boolean;
      },
    ): Promise<void> {
      const convId = conversationId(ref);
      const coverage = await postCoverage(convId);
      const cursorId = page.beforeId ?? page.afterId;
      let cursorInConversation = false;
      if (coverage && cursorId) {
        const anchor = (await runTransaction(STORES.POSTS, "readonly", (tx) =>
          requestResult(tx.objectStore(STORES.POSTS).get(cursorId)),
        )) as StoredPost | undefined;
        cursorInConversation = anchor?.conv_id === convId;
      }
      const existingIds =
        coverage && !cursorId
          ? new Set((await this.getPosts(ref)).map((post) => post.id))
          : new Set<string>();
      const connection = connectPostPage({
        hasCoverage: !!coverage,
        cursorId,
        cursorInConversation,
        incomingOverlapsExisting: incoming.some((post) =>
          existingIds.has(post.id),
        ),
      });
      // A cursor page without an existing boundary is a disconnected fragment;
      // it may be displayed remotely but cannot establish local coverage.
      if (connection === "ignore") return;
      if (connection === "replace-window") {
        await clearConversationPostWindow(convId);
      }
      if (incoming.length) {
        await this.savePosts(ref, incoming, {
          extendCoverage: true,
          reachedOldest: !!page.beforeId && page.exhausted,
          reachedNewest: !page.beforeId && (!page.afterId || page.exhausted),
        });
        return;
      }
      if (coverage && page.exhausted) {
        await runTransaction(STORES.SYNC, "readwrite", async (tx) => {
          const store = tx.objectStore(STORES.SYNC);
          const current = (await requestResult(
            store.get(`posts:${convId}`),
          )) as PostCoverage | undefined;
          if (!current) return;
          store.put({
            ...current,
            reached_oldest: current.reached_oldest || !!page.beforeId,
            reached_newest: current.reached_newest || !page.beforeId,
            updated_at: Date.now(),
          });
        });
      }
    },

    async advancePostRevision(
      convId: string,
      revision: number,
      revisionSum?: string,
    ): Promise<void> {
      const scope = `posts:${convId}`;
      await runTransaction(
        [STORES.SYNC, STORES.ME_ACCESS],
        "readwrite",
        async (tx) => {
          const store = tx.objectStore(STORES.SYNC);
          const current = (await requestResult(store.get(scope))) as
            PostCoverage | undefined;
          if (!current?.oldest || !current.newest) return;
          store.put({
            scope,
            kind: "posts",
            conv_id: convId,
            known_revision: Math.max(current?.known_revision ?? 0, revision),
            revision_sum: revisionSum ?? current.revision_sum,
            oldest: current.oldest,
            newest: current.newest,
            reached_oldest: current.reached_oldest,
            reached_newest: current.reached_newest,
            updated_at: Date.now(),
          } satisfies PostCoverage);
        },
      );
    },

    async getKnownPostRevision(convId: string): Promise<number> {
      return (await postCoverage(convId))?.known_revision ?? 0;
    },

    async getKnownPostRevisionSum(convId: string): Promise<string | null> {
      return (await postCoverage(convId))?.revision_sum ?? null;
    },

    async reconcilePostRevisions(
      ref: Pick<Conversation, "type" | "id"> &
        Partial<Pick<Conversation, "conv_id">>,
      incoming: PostEntity[],
      revision: number,
      revisionSum?: string,
    ): Promise<void> {
      const convId = conversationId(ref);
      const coverage = await postCoverage(convId);
      if (!coverage?.oldest || !coverage.newest) return;
      await this.savePosts(ref, incoming, { extendCoverage: false });
      if (coverage.reached_newest) {
        const appended = incoming
          .filter((post) => post.sequence > coverage.newest.order)
          .sort((left, right) => left.sequence - right.sequence);
        if (appended.length) {
          await this.savePosts(ref, appended, {
            extendCoverage: true,
            reachedNewest: true,
          });
        }
      }
      await this.advancePostRevision(convId, revision, revisionSum);
    },

    async getPosts(
      ref: Pick<Conversation, "type" | "id"> &
        Partial<Pick<Conversation, "conv_id">>,
    ): Promise<Post[]> {
      const convId = conversationId(ref);
      return runTransaction(
        [STORES.ME_ACCESS, STORES.POSTS, STORES.USERS],
        "readonly",
        async (tx) => {
          const access = await requestResult(
            tx
              .objectStore(STORES.ME_ACCESS)
              .get([actorId(), "conversation", convId]),
          );
          if (!access) return [];
          const rows = (await requestResult(
            tx
              .objectStore(STORES.POSTS)
              .index("by-conversation-sequence")
              .getAll(
                IDBKeyRange.bound(
                  [convId, 0],
                  [convId, Number.MAX_SAFE_INTEGER],
                ),
              ),
          )) as StoredPost[];
          const users = tx.objectStore(STORES.USERS);
          const materialized = await Promise.all(
            rows.map(
              async ({
                size: _s,
                touched_at: _t,
                eviction_tier: _e,
                ...post
              }) => {
                void _s;
                void _t;
                void _e;
                const author = post.user_id
                  ? ((await requestResult(users.get(post.user_id))) as
                      ObjectiveUser | undefined)
                  : undefined;
                const replyAuthor = post.reply_user_id
                  ? ((await requestResult(users.get(post.reply_user_id))) as
                      ObjectiveUser | undefined)
                  : undefined;
                return {
                  ...post,
                  username: author?.username ?? null,
                  handle: author?.handle ?? null,
                  reply_username: replyAuthor?.username ?? null,
                  reply_handle: replyAuthor?.handle ?? null,
                } as Post;
              },
            ),
          );
          return materialized as Post[];
        },
      );
    },

    async trimConversationPosts(
      ref: Pick<Conversation, "type" | "id"> &
        Partial<Pick<Conversation, "conv_id">>,
    ): Promise<void> {
      const convId = conversationId(ref);
      const cutoff = await deviceConversationCutoff(convId);
      const rows = await runTransaction(
        STORES.POSTS,
        "readonly",
        async (tx) =>
          (await requestResult(
            tx
              .objectStore(STORES.POSTS)
              .index("by-conversation-sequence")
              .getAll(
                IDBKeyRange.bound(
                  [convId, 0],
                  [convId, Number.MAX_SAFE_INTEGER],
                ),
              ),
          )) as StoredPost[],
      );
      const deleteCount =
        cutoff === null
          ? Math.max(0, rows.length - 200)
          : rows.findIndex((row) => Date.parse(row.created_at) >= cutoff);
      const normalizedCount =
        cutoff !== null && deleteCount < 0 ? rows.length : deleteCount;
      await deleteConversationPostPrefix(convId, normalizedCount);
    },

    async getConversationPolicy(ref: Pick<Conversation, "type" | "id">) {
      const row = await runTransaction(STORES.SAVE, "readonly", (tx) =>
        requestResult(
          tx
            .objectStore(STORES.SAVE)
            .get([actorId(), "conversation", conversationId(ref)]),
        ),
      );
      return Policies.conversation((row as RetentionRow | undefined)?.mode);
    },

    async setConversationPolicy(
      ref: Pick<Conversation, "type" | "id">,
      policy: ConversationDownloadPolicy,
    ): Promise<void> {
      const days = CONVERSATION_RETENTION_DAYS[policy];
      const row: RetentionRow = {
        claimant: actorId(),
        kind: "conversation",
        object_id: conversationId(ref),
        mode: policy,
        keep_after_ms: days ? Date.now() - days * 86_400_000 : null,
        protected_until: 0,
        materialized: false,
        bytes: 0,
        last_touched_at: Date.now(),
        missing_reason: "never-downloaded",
      };
      await runTransaction(STORES.SAVE, "readwrite", (tx) => {
        tx.objectStore(STORES.SAVE).put(row);
      });
      await this.trimConversationPosts(ref);
    },

    async getConversationPolicies() {
      const rows = await runTransaction(
        STORES.SAVE,
        "readonly",
        async (tx) =>
          (await requestResult(
            tx.objectStore(STORES.SAVE).getAll(),
          )) as RetentionRow[],
      );
      const conversations = await this.getConversations();
      return rows
        .filter(
          (row) => row.claimant === actorId() && row.kind === "conversation",
        )
        .flatMap((row) => {
          const ref = conversations.find(
            (entry) => entry.conv_id === row.object_id,
          );
          return ref ? [{ ref, policy: Policies.conversation(row.mode) }] : [];
        });
    },

    async markConversationPolicySynced(ref: Pick<Conversation, "type" | "id">) {
      const key: [string, "conversation", string] = [
        actorId(),
        "conversation",
        conversationId(ref),
      ];
      await runTransaction(STORES.SAVE, "readwrite", async (tx) => {
        const store = tx.objectStore(STORES.SAVE);
        const row = (await requestResult(store.get(key))) as
          RetentionRow | undefined;
        if (row)
          store.put({ ...row, materialized: true, missing_reason: null });
      });
    },

    async saveArticleList(
      entries: ArticleWithMeta[],
      membership: Pick<ArticleMembership, "view" | "group_id"> = {
        view: "all",
        group_id: null,
      },
    ): Promise<void> {
      for (const entry of entries) {
        await upsertArticle(actorId(), entry, {
          ...membership,
          sort_at: entry.list_sort_at ?? entry.created_at,
        });
      }
    },

    async getArticleList(): Promise<Article[]> {
      const rows = (await accessRows(
        actorId(),
        "article",
      )) as ArticleAccessRow[];
      const articles = await Promise.all(rows.map(materializeArticle));
      return articles
        .filter((value): value is Article => !!value)
        .sort((left, right) => right.created_at.localeCompare(left.created_at));
    },

    async getSavedArticleList(): Promise<Article[]> {
      const entries = await this.getArticleList();
      const result: Article[] = [];
      for (const article of entries) {
        if ((await this.getArticlePolicy(article.id)).mode === "retained") {
          result.push(article);
        }
      }
      return result;
    },

    async mergeArticleListEntries(
      entries: ArticleWithMeta[],
      membership?: Pick<ArticleMembership, "view" | "group_id">,
    ): Promise<void> {
      await this.saveArticleList(entries, membership);
    },

    async reconcileArticlePage(
      entries: ArticleWithMeta[],
      page: {
        view: ArticleMembership["view"];
        groupId: string | null;
        direction: "before" | "after";
        cursor: { sortAt: string; id: string } | null;
        hasMore: boolean;
      },
    ): Promise<void> {
      await this.saveArticleList(entries, {
        view: page.view,
        group_id: page.groupId,
      });
      await runTransaction(
        [STORES.SYNC, STORES.ME_ACCESS],
        "readwrite",
        async (tx) => {
          type Boundary = { order: string; id: string };
          type ArticleCoverageDetail = ContinuousCoverage<Boundary>;
          const boundary = (
            entry: ArticleWithMeta | undefined,
          ): Boundary | null =>
            entry
              ? {
                  order: entry.list_sort_at ?? entry.created_at,
                  id: entry.id,
                }
              : null;

          const store = tx.objectStore(STORES.SYNC);
          const scope = `me:${actorId()}:articles:${page.view}:${page.groupId ?? "all"}`;
          if (!page.cursor) {
            // A root page replaces this list projection. Memberships outside the
            // new proof are removed so deleted/moved articles cannot survive as
            // offline phantoms indefinitely.
            const pageIds = new Set(entries.map((entry) => entry.id));
            const accessStore = tx.objectStore(STORES.ME_ACCESS);
            const rows = (await requestResult(
              accessStore
                .index("by-me-kind")
                .getAll(IDBKeyRange.only([actorId(), "article"])),
            )) as ArticleAccessRow[];
            const { put, remove } = articleListRootMemberships({
              rows,
              pageIds,
              view: page.view,
              groupId: page.groupId,
            });
            for (const row of put) accessStore.put(row);
            for (const row of remove) {
              accessStore.delete([row.me_id, row.kind, row.object_id]);
            }
            if (!entries.length) {
              store.delete(scope);
              return;
            }
          }
          const current = (await requestResult(store.get(scope))) as
            { detail?: ArticleCoverageDetail } | undefined;
          const first = boundary(entries[0]);
          const last = boundary(entries[entries.length - 1]);
          const detail = mergeCursorCoverage({
            current: current?.detail ?? null,
            direction: page.direction,
            cursor: page.cursor
              ? { id: page.cursor.id, order: page.cursor.sortAt }
              : null,
            first,
            last,
            exhausted: !page.hasMore,
          });
          // An isolated cursor page is useful cached data but proves no contiguous
          // range, so it deliberately leaves the coverage row unchanged.
          if (!detail) return;
          store.put({
            scope,
            kind: "article-list",
            me_id: actorId(),
            complete: detail.reached_newest && detail.reached_oldest,
            updated_at: Date.now(),
            detail,
          });
        },
      );
    },

    async upsertArticleListEntry(entry: ArticleWithMeta): Promise<void> {
      await this.saveArticleList([entry], { view: "direct", group_id: null });
    },

    async removeArticle(articleId: string): Promise<void> {
      await runTransaction(
        [STORES.ME_ACCESS, STORES.ME_ARTICLE_STATE],
        "readwrite",
        (tx) => {
          tx.objectStore(STORES.ME_ACCESS).delete([
            actorId(),
            "article",
            articleId,
          ]);
          tx.objectStore(STORES.ME_ARTICLE_STATE).delete([
            actorId(),
            articleId,
          ]);
        },
      );
    },

    async purgeArticle(articleId: string): Promise<void> {
      await runTransaction(
        [
          STORES.ARTICLES,
          STORES.ARTICLE_SEGMENTS,
          STORES.ME_ACCESS,
          STORES.ME_ARTICLE_STATE,
          STORES.SAVE,
        ],
        "readwrite",
        async (tx) => {
          tx.objectStore(STORES.ARTICLES).delete(articleId);
          const segments = await requestResult(
            tx
              .objectStore(STORES.ARTICLE_SEGMENTS)
              .index("by-article")
              .getAllKeys(IDBKeyRange.only(articleId)),
          );
          const access = await requestResult(
            tx
              .objectStore(STORES.ME_ACCESS)
              .index("by-object")
              .getAllKeys(IDBKeyRange.only(["article", articleId])),
          );
          const states = (
            (await requestResult(
              tx.objectStore(STORES.ME_ARTICLE_STATE).getAll(),
            )) as ArticleUserStateRow[]
          )
            .filter((row) => row.article_id === articleId)
            .map((row) => [row.me_id, row.article_id] as IDBValidKey);
          const saves = await requestResult(
            tx
              .objectStore(STORES.SAVE)
              .index("by-resource")
              .getAllKeys(IDBKeyRange.only(["article", articleId])),
          );
          for (const key of segments) {
            tx.objectStore(STORES.ARTICLE_SEGMENTS).delete(key);
          }
          for (const key of access)
            tx.objectStore(STORES.ME_ACCESS).delete(key);
          for (const key of states) {
            tx.objectStore(STORES.ME_ARTICLE_STATE).delete(key);
          }
          for (const key of saves) tx.objectStore(STORES.SAVE).delete(key);
        },
      );
    },

    async saveArticleMeta(
      article: ArticleWithMeta,
      membership: Pick<ArticleMembership, "view" | "group_id"> = {
        view: "direct",
        group_id: null,
      },
    ): Promise<void> {
      await upsertArticle(actorId(), article, {
        ...membership,
        sort_at: article.list_sort_at ?? article.created_at,
      });
    },

    async getArticleMeta(articleId: string): Promise<Article | null> {
      const row = await runTransaction(STORES.ME_ACCESS, "readonly", (tx) =>
        requestResult(
          tx
            .objectStore(STORES.ME_ACCESS)
            .get([actorId(), "article", articleId]),
        ),
      );
      return row ? materializeArticle(row as ArticleAccessRow) : null;
    },

    async getArticleProgress(
      articleId: string,
    ): Promise<ReadingProgressVersion | null> {
      const state = await getArticleState(actorId(), articleId);
      const value = Values.resolved(state.resume);
      return {
        offset: value.value,
        updatedAt: value.updatedAt,
        synced: !value.pending,
      };
    },

    async setArticleBookmark(articleId: string, value: boolean) {
      const meId = actorId();
      return runTransaction(
        STORES.ME_ARTICLE_STATE,
        "readwrite",
        async (tx) => {
          const store = tx.objectStore(STORES.ME_ARTICLE_STATE);
          const current =
            ((await requestResult(store.get([meId, articleId]))) as
              ArticleUserStateRow | undefined) ??
            defaultArticleState(meId, articleId);
          current.bookmark = Values.propose(current.bookmark, value);
          current.pending = statePending(current);
          store.put(current);
          const resolved = Values.resolved(current.bookmark);
          return {
            value: resolved.value,
            purpose: `article:${articleId}:bookmark`,
            updatedAt: resolved.updatedAt,
            syncedAt: null,
          } satisfies VersionedValue<boolean>;
        },
      );
    },

    async reconcileArticleBookmark(
      articleId: string,
      remote: { value: boolean; updatedAt: number },
    ) {
      const meId = actorId();
      return runTransaction(
        STORES.ME_ARTICLE_STATE,
        "readwrite",
        async (tx) => {
          const store = tx.objectStore(STORES.ME_ARTICLE_STATE);
          const current =
            ((await requestResult(store.get([meId, articleId]))) as
              ArticleUserStateRow | undefined) ??
            defaultArticleState(meId, articleId);
          current.bookmark = Values.reconcile(current.bookmark, remote);
          current.pending = statePending(current);
          store.put(current);
          const resolved = Values.resolved(current.bookmark);
          return {
            value: resolved.value,
            purpose: `article:${articleId}:bookmark`,
            updatedAt: resolved.updatedAt,
            syncedAt: resolved.pending ? null : resolved.updatedAt,
          } satisfies VersionedValue<boolean>;
        },
      );
    },

    async getPendingArticleBookmarks() {
      const accessible = new Set(
        (await this.getArticleList()).map((article) => article.id),
      );
      return runTransaction(STORES.ME_ARTICLE_STATE, "readonly", async (tx) => {
        const rows = (await requestResult(
          tx
            .objectStore(STORES.ME_ARTICLE_STATE)
            .index("by-pending")
            .getAll(IDBKeyRange.only([actorId(), 1])),
        )) as ArticleUserStateRow[];
        return rows.flatMap((row) => {
          if (!accessible.has(row.article_id)) return [];
          const value = Values.resolved(row.bookmark);
          return value.pending
            ? [
                {
                  articleId: row.article_id,
                  value: value.value,
                  updatedAt: value.updatedAt,
                },
              ]
            : [];
        });
      });
    },

    async setPendingArticleProgress(
      articleId: string,
      offset: number,
      offline: boolean,
    ) {
      const meId = actorId();
      return runTransaction(
        STORES.ME_ARTICLE_STATE,
        "readwrite",
        async (tx) => {
          const store = tx.objectStore(STORES.ME_ARTICLE_STATE);
          const current =
            ((await requestResult(store.get([meId, articleId]))) as
              ArticleUserStateRow | undefined) ??
            defaultArticleState(meId, articleId);
          current.resume = Values.propose(current.resume, offset);
          const furthest = Values.resolved(current.furthest);
          if (offline && offset > furthest.value) {
            current.furthest = Values.propose(current.furthest, offset);
          } else if (!offline && current.furthest.proposal) {
            // An explicit online navigation supersedes an older offline proposal.
            current.furthest = {
              ...current.furthest,
              proposal: null,
            };
          }
          current.pending = 1;
          store.put(current);
          const value = Values.resolved(current.resume);
          return {
            offset: value.value,
            updatedAt: value.updatedAt,
            synced: false,
          };
        },
      );
    },

    async reconcileArticleProgress(
      articleId: string,
      remote: { offset: number; updatedAt: number },
      merge: "override" | "furthest" = "override",
    ) {
      const meId = actorId();
      return runTransaction(
        STORES.ME_ARTICLE_STATE,
        "readwrite",
        async (tx) => {
          const store = tx.objectStore(STORES.ME_ARTICLE_STATE);
          const current =
            ((await requestResult(store.get([meId, articleId]))) as
              ArticleUserStateRow | undefined) ??
            defaultArticleState(meId, articleId);
          if (merge === "furthest") {
            current.resume = Values.assignment(remote.offset, remote.updatedAt);
            current.furthest = Values.assignment(
              remote.offset,
              remote.updatedAt,
            );
          } else {
            current.resume = Values.reconcile(current.resume, {
              value: remote.offset,
              updatedAt: remote.updatedAt,
            });
            const furthest = Values.resolved(current.furthest);
            current.furthest = Values.assignment(
              Math.max(remote.offset, furthest.value),
              Math.max(remote.updatedAt, furthest.updatedAt),
            );
          }
          current.pending = statePending(current);
          store.put(current);
          const value = Values.resolved(current.resume);
          return {
            offset: value.value,
            updatedAt: value.updatedAt,
            synced: !value.pending,
          };
        },
      );
    },

    async getPendingArticleProgress() {
      const accessible = new Set(
        (await this.getArticleList()).map((article) => article.id),
      );
      return runTransaction(STORES.ME_ARTICLE_STATE, "readonly", async (tx) => {
        const rows = (await requestResult(
          tx
            .objectStore(STORES.ME_ARTICLE_STATE)
            .index("by-pending")
            .getAll(IDBKeyRange.only([actorId(), 1])),
        )) as ArticleUserStateRow[];
        return rows.flatMap((row) => {
          if (!accessible.has(row.article_id)) return [];
          const furthest = Values.resolved(row.furthest);
          return furthest.pending
            ? [
                {
                  articleId: row.article_id,
                  offset: furthest.value,
                  updatedAt: furthest.updatedAt,
                },
              ]
            : [];
        });
      });
    },

    async getArticlePolicy(articleId: string): Promise<ArticleDownloadPolicy> {
      const meId = actorId();
      return runTransaction(STORES.SAVE, "readwrite", async (tx) => {
        const store = tx.objectStore(STORES.SAVE);
        const row = (await requestResult(
          store.get([meId, "article", articleId]),
        )) as RetentionRow | undefined;
        const policy = Policies.article(
          row?.mode === "retained"
            ? {
                mode: "retained",
                days: Number(row.keep_after_ms),
                expiresAt: row.protected_until,
              }
            : null,
        );
        if (policy.mode !== "retained" || policy.expiresAt > Date.now()) {
          return policy;
        }
        store.put({
          ...row!,
          mode: "auto",
          keep_after_ms: null,
          protected_until: 0,
          materialized: false,
          bytes: 0,
          last_touched_at: Date.now(),
          missing_reason: null,
        } satisfies RetentionRow);
        return { mode: "auto" };
      });
    },

    async setArticlePolicy(articleId: string, policy: ArticleDownloadPolicy) {
      const normalized = Policies.article(policy);
      const row: RetentionRow = {
        claimant: actorId(),
        kind: "article",
        object_id: articleId,
        mode: normalized.mode,
        keep_after_ms: normalized.mode === "retained" ? normalized.days : null,
        protected_until:
          normalized.mode === "retained" ? normalized.expiresAt : 0,
        materialized: false,
        bytes: 0,
        last_touched_at: Date.now(),
        missing_reason:
          normalized.mode === "retained" ? "never-downloaded" : null,
      };
      await runTransaction(STORES.SAVE, "readwrite", (tx) => {
        tx.objectStore(STORES.SAVE).put(row);
      });
    },

    async getArticlePolicies() {
      return runTransaction(STORES.SAVE, "readonly", async (tx) => {
        const rows = (await requestResult(
          tx.objectStore(STORES.SAVE).getAll(),
        )) as RetentionRow[];
        return rows
          .filter((row) => row.claimant === actorId() && row.kind === "article")
          .map((row) => ({
            articleId: row.object_id,
            policy:
              row.mode === "retained"
                ? ({
                    mode: "retained",
                    days: Number(row.keep_after_ms) as 1 | 7 | 180,
                    expiresAt: row.protected_until,
                  } as ArticleDownloadPolicy)
                : ({ mode: "auto" } as ArticleDownloadPolicy),
          }));
      });
    },

    async markArticlePolicySynced(articleId: string, bytes = 0) {
      const key: [string, "article", string] = [
        actorId(),
        "article",
        articleId,
      ];
      await runTransaction(STORES.SAVE, "readwrite", async (tx) => {
        const store = tx.objectStore(STORES.SAVE);
        const row = (await requestResult(store.get(key))) as
          RetentionRow | undefined;
        if (row) {
          store.put({
            ...row,
            materialized: true,
            missing_reason: null,
            bytes,
            last_touched_at: Date.now(),
          });
        }
      });
    },

    async saveArticleSegment(articleId: string, offset: number, data: unknown) {
      const retained =
        (await this.getArticlePolicy(articleId)).mode === "retained";
      const startOffset =
        data &&
        typeof data === "object" &&
        typeof (data as { offset?: unknown }).offset === "number"
          ? (data as { offset: number }).offset
          : offset;
      await runTransaction(STORES.ARTICLE_SEGMENTS, "readwrite", async (tx) => {
        const store = tx.objectStore(STORES.ARTICLE_SEGMENTS);
        const previous = (await requestResult(
          store.get([articleId, startOffset]),
        )) as StoredArticleSegment | undefined;
        if (previous) {
          assertImmutableEntity(
            previous.value,
            data,
            `article:${articleId}:${startOffset}`,
          );
        }
        store.put({
          article_id: articleId,
          start_offset: startOffset,
          value: data,
          size: Values.size(data),
          touched_at: Date.now(),
          eviction_tier: retained ? 2 : 0,
        } satisfies StoredArticleSegment);
      });
    },

    async getArticleSegment<T>(
      articleId: string,
      offset: number,
    ): Promise<T | null> {
      const row = await runTransaction(
        STORES.ARTICLE_SEGMENTS,
        "readonly",
        async (tx) => {
          const request = tx
            .objectStore(STORES.ARTICLE_SEGMENTS)
            .index("by-article-start")
            .openCursor(
              IDBKeyRange.bound([articleId, 0], [articleId, offset]),
              "prev",
            );
          const cursor = await requestResult(request);
          return (cursor?.value as StoredArticleSegment<T> | undefined) ?? null;
        },
      );
      if (!row) return null;
      const value = row.value as T & { offset?: number; content?: string };
      if (
        typeof value.offset === "number" &&
        typeof value.content === "string" &&
        value.offset < offset
      ) {
        const relative = offset - value.offset;
        if (relative >= value.content.length) return null;
        return { ...value, offset, content: value.content.slice(relative) };
      }
      return value;
    },

    async getDraft(
      ref: Pick<Conversation, "type" | "id">,
    ): Promise<DraftVersion | null> {
      const state = await getConversationState(actorId(), conversationId(ref));
      const draft = Values.resolved(state.draft);
      return {
        content: draft.value,
        updatedAt: draft.updatedAt,
        syncedAt: draft.pending ? null : draft.updatedAt,
      };
    },

    async saveDraft(
      ref: Pick<Conversation, "type" | "id">,
      content: string,
      options?: { updatedAt?: number; synced?: boolean },
    ) {
      const meId = actorId();
      const convId = conversationId(ref);
      return runTransaction(STORES.ME_CONV_STATE, "readwrite", async (tx) => {
        const store = tx.objectStore(STORES.ME_CONV_STATE);
        const current =
          ((await requestResult(store.get([meId, convId]))) as
            ConversationUserStateRow | undefined) ??
          defaultConversationState(meId, convId);
        current.draft = options?.synced
          ? Values.reconcile(current.draft, {
              value: content,
              updatedAt: options.updatedAt ?? 0,
            })
          : Values.propose(current.draft, content, options?.updatedAt);
        current.pending = statePending(current);
        store.put(current);
        const draft = Values.resolved(current.draft);
        return {
          content: draft.value,
          updatedAt: draft.updatedAt,
          syncedAt: draft.pending ? null : draft.updatedAt,
        } satisfies DraftVersion;
      });
    },

    async getPendingDraftRefs() {
      const entries = await this.getConversations();
      const rows = await runTransaction(
        STORES.ME_CONV_STATE,
        "readonly",
        async (tx) =>
          (await requestResult(
            tx
              .objectStore(STORES.ME_CONV_STATE)
              .index("by-pending")
              .getAll(IDBKeyRange.only([actorId(), 1])),
          )) as ConversationUserStateRow[],
      );
      return rows.flatMap((row) => {
        if (!Values.resolved(row.draft).pending) return [];
        const entry = entries.find((item) => item.conv_id === row.conv_id);
        return entry ? [{ type: entry.type, id: entry.id }] : [];
      });
    },
  };
  return repository;
}

export type OfflineRepository = ReturnType<typeof createOfflineRepository>;

/** Bind every repository operation to an immutable actor snapshot. */
export function offlineRepository(userId: string): OfflineRepository {
  return createOfflineRepository(userId);
}

export async function handleOfflineQuotaPressure(
  bytesToFree: number,
  allowProtected = false,
  excludedArticles: ReadonlySet<string> = new Set(),
): Promise<number> {
  if (bytesToFree <= 0) return 0;
  let freed = 0;
  const now = Date.now();
  const claims = await runTransaction(
    STORES.SAVE,
    "readonly",
    async (tx) =>
      (await requestResult(
        tx.objectStore(STORES.SAVE).getAll(),
      )) as RetentionRow[],
  );
  const evictedArticles = new Set<string>();
  const evictedConversations = new Set<string>();
  const articleProtected = async (articleId: string) =>
    runTransaction(STORES.SAVE, "readonly", async (tx) => {
      const current = (await requestResult(
        tx
          .objectStore(STORES.SAVE)
          .index("by-resource")
          .getAll(IDBKeyRange.only(["article", articleId])),
      )) as RetentionRow[];
      return current.some(
        (claim) =>
          claim.mode === "retained" && claim.protected_until > Date.now(),
      );
    });

  // Immutable text segments can be evicted independently. Candidate discovery
  // is separate from bounded deletion transactions to avoid a large IDB spike.
  const segmentRows = await runTransaction(
    STORES.ARTICLE_SEGMENTS,
    "readonly",
    async (tx) =>
      (await requestResult(
        tx.objectStore(STORES.ARTICLE_SEGMENTS).index("by-eviction").getAll(),
      )) as StoredArticleSegment[],
  );
  segmentRows.sort(
    (left, right) =>
      left.eviction_tier - right.eviction_tier ||
      left.touched_at - right.touched_at,
  );
  for (const row of segmentRows) {
    if (freed >= bytesToFree) break;
    if (excludedArticles.has(row.article_id)) continue;
    const deletedBytes = await runTransaction(
      [STORES.ARTICLE_SEGMENTS, STORES.SAVE],
      "readwrite",
      async (tx) => {
        const claimsNow = (await requestResult(
          tx
            .objectStore(STORES.SAVE)
            .index("by-resource")
            .getAll(IDBKeyRange.only(["article", row.article_id])),
        )) as RetentionRow[];
        const protectedNow = claimsNow.some(
          (claim) =>
            claim.mode === "retained" && claim.protected_until > Date.now(),
        );
        if (!allowProtected && protectedNow) return 0;
        const key: IDBValidKey = [row.article_id, row.start_offset];
        const store = tx.objectStore(STORES.ARTICLE_SEGMENTS);
        const current = (await requestResult(store.get(key))) as
          StoredArticleSegment | undefined;
        if (!current) return 0;
        store.delete(key);
        return current.size;
      },
    );
    if (!deletedBytes) continue;
    freed += deletedBytes;
    evictedArticles.add(row.article_id);
  }

  // A Bundle catalog and its resources form one offline readability unit. Do
  // not leave a catalog pointing at individually evicted dependencies.
  if (freed < bytesToFree) {
    const groups = new Map<string, { bytes: number; createdAt: number }>();
    for (const head of await extentFiles.list("article:")) {
      const articleId = FileIds.articleId(head.id);
      if (!articleId) continue;
      const current = groups.get(articleId) ?? {
        bytes: 0,
        createdAt: head.created_at,
      };
      current.bytes += head.size;
      current.createdAt = Math.min(current.createdAt, head.created_at);
      groups.set(articleId, current);
    }
    const bundles = [...groups].sort(
      (left, right) => left[1].createdAt - right[1].createdAt,
    );
    for (const [articleId] of bundles) {
      if (freed >= bytesToFree) break;
      if (excludedArticles.has(articleId)) continue;
      if (!allowProtected && (await articleProtected(articleId))) continue;
      const deleted = await extentFiles.deletePrefix(
        FileIds.articlePrefix(articleId),
      );
      if (!deleted.bytes) continue;
      freed += deleted.bytes;
      evictedArticles.add(articleId);
    }
  }

  // A conversation is evicted only from its oldest edge, preserving the one
  // interval invariant. The longest device-wide claim protects that prefix.
  if (freed < bytesToFree) {
    const posts = await runTransaction(
      STORES.POSTS,
      "readonly",
      async (tx) =>
        (await requestResult(
          tx.objectStore(STORES.POSTS).getAll(),
        )) as StoredPost[],
    );
    const byConversation = new Map<string, StoredPost[]>();
    for (const post of posts) {
      const rows = byConversation.get(post.conv_id) ?? [];
      rows.push(post);
      byConversation.set(post.conv_id, rows);
    }
    const conversations = [...byConversation.entries()].sort(
      (left, right) =>
        Math.min(...left[1].map((row) => row.touched_at)) -
        Math.min(...right[1].map((row) => row.touched_at)),
    );
    for (const [convId, rows] of conversations) {
      if (freed >= bytesToFree) break;
      rows.sort((left, right) => left.sequence - right.sequence);
      const retentionDays = claims.reduce((days, claim) => {
        if (claim.kind !== "conversation" || claim.object_id !== convId)
          return days;
        return Math.max(
          days,
          CONVERSATION_RETENTION_DAYS[Policies.conversation(claim.mode)],
        );
      }, 0);
      const cutoff = retentionDays ? now - retentionDays * 86_400_000 : null;
      let deleteCount = 0;
      let candidateBytes = freed;
      for (const row of rows) {
        if (candidateBytes >= bytesToFree) break;
        const protectedByClaim =
          cutoff !== null && Date.parse(row.created_at) >= cutoff;
        if (protectedByClaim && !allowProtected) break;
        deleteCount += 1;
        candidateBytes += row.size;
      }
      if (!deleteCount) continue;
      const deleted = await deleteConversationPostPrefix(
        convId,
        deleteCount,
        now,
        allowProtected,
      );
      freed += deleted.bytes;
      if (deleted.bytes) evictedConversations.add(convId);
    }
  }

  if (evictedArticles.size || evictedConversations.size) {
    await runTransaction(STORES.SAVE, "readwrite", async (tx) => {
      const store = tx.objectStore(STORES.SAVE);
      const currentClaims = (await requestResult(
        store.getAll(),
      )) as RetentionRow[];
      for (const claim of currentClaims) {
        const evicted =
          claim.kind === "article"
            ? evictedArticles.has(claim.object_id)
            : evictedConversations.has(claim.object_id);
        if (!evicted) continue;
        store.put({
          ...claim,
          materialized: false,
          missing_reason: "evicted",
          bytes: 0,
        });
      }
    });
  }
  return freed;
}
