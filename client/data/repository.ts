import type {
  ArticleWithMeta,
  Conversation,
  Post,
  User,
} from "@/shared/types/api";
import { dmConvId, groupConvId, parseConvId } from "@/shared/conversations/id";
import { requestResult, runTransaction } from "./idb";
import { STORES, GLOBAL_KEYS, type StoreName } from "./schema";
import type {
  AccessRow,
  ArticleAccessRow,
  ArticleMembership,
  ArticleUserStateRow,
  Assignment,
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
  StoredPost,
} from "./model";
import { extentFiles } from "./files";
import { FileIds } from "./fileIds";

export type ConversationDownloadPolicy = "auto" | "week" | "half-year";
export type ArticleDownloadPolicy =
  { mode: "auto" } | { mode: "retained"; days: 1 | 7 | 180; expiresAt: number };

export const ARTICLE_RETENTION_DAYS = [1, 7, 180] as const;
export const CONVERSATION_RETENTION_DAYS = {
  auto: 0,
  week: 7,
  "half-year": 180,
} as const satisfies Record<ConversationDownloadPolicy, number>;

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

interface GroupRow {
  id: string;
  conv_id: string;
  revision: number;
  handle: string;
  name: string;
  has_password: number;
  members_hidden: number;
  admin_only: number;
  no_leave: number;
  last_message: string | null;
  last_at: string | null;
  touched_at: number;
}

interface DmRow {
  conv_id: string;
  revision: number;
  peer_a: string;
  peer_b: string;
  last_message: string | null;
  last_at: string | null;
  touched_at: number;
}

const DEFAULT_ASSIGNMENT_TIME = 0;
let userScope = "anonymous";

class Values {
  static size(value: unknown): number {
    try {
      return new TextEncoder().encode(JSON.stringify(value)).byteLength;
    } catch {
      return 0;
    }
  }

  static equal(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  static nextTimestamp(previous = 0): number {
    return Math.max(Date.now(), previous + 1);
  }

  static assignment<T>(value: T, updatedAt = 0): Assignment<T> {
    return {
      base: { value, updated_at: updatedAt },
      proposal: null,
    };
  }

  static resolved<T>(assignment: Assignment<T>): {
    value: T;
    updatedAt: number;
    pending: boolean;
  } {
    const proposal = assignment.proposal;
    if (proposal && proposal.updated_at > assignment.base.updated_at) {
      return {
        value: proposal.value,
        updatedAt: proposal.updated_at,
        pending: true,
      };
    }
    return {
      value: assignment.base.value,
      updatedAt: assignment.base.updated_at,
      pending: false,
    };
  }

  static reconcile<T>(
    current: Assignment<T> | null,
    remote: { value: T; updatedAt: number },
  ): Assignment<T> {
    const base = { value: remote.value, updated_at: remote.updatedAt };
    if (!current?.proposal || current.proposal.updated_at <= remote.updatedAt) {
      return { base, proposal: null };
    }
    return { base, proposal: current.proposal };
  }

  static propose<T>(
    current: Assignment<T> | null,
    value: T,
    updatedAt?: number,
  ): Assignment<T> {
    const previous = current
      ? Math.max(
          current.base.updated_at,
          current.proposal?.updated_at ?? DEFAULT_ASSIGNMENT_TIME,
        )
      : DEFAULT_ASSIGNMENT_TIME;
    const stamp = updatedAt ?? Values.nextTimestamp(previous);
    return {
      base: current?.base ?? { value, updated_at: 0 },
      proposal: {
        value,
        updated_at: stamp,
        operation_id: `${stamp.toString(36)}-${Math.random().toString(36).slice(2)}`,
      },
    };
  }
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

function activeMe(): string {
  return userScope;
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
  const rows = await runTransaction(
    STORES.POSTS,
    "readonly",
    async (tx) =>
      (await requestResult(
        tx
          .objectStore(STORES.POSTS)
          .index("by-conversation-sequence")
          .getAll(
            IDBKeyRange.bound([convId, 0], [convId, Number.MAX_SAFE_INTEGER]),
          ),
      )) as StoredPost[],
  );
  await deleteConversationPostPrefix(convId, rows, rows.length);
  await runTransaction(STORES.SYNC, "readwrite", (tx) => {
    tx.objectStore(STORES.SYNC).delete(`posts:${convId}`);
  });
}

async function deleteKeysBatched(
  storeName: StoreName,
  keys: IDBValidKey[],
): Promise<void> {
  for (
    let start = 0;
    start < keys.length;
    start += MAX_RECORD_DELETES_PER_TRANSACTION
  ) {
    const batch = keys.slice(start, start + MAX_RECORD_DELETES_PER_TRANSACTION);
    await runTransaction(storeName, "readwrite", (tx) => {
      const store = tx.objectStore(storeName);
      for (const key of batch) store.delete(key);
    });
  }
}

async function deleteConversationPostPrefix(
  convId: string,
  orderedRows: StoredPost[],
  count: number,
  updatedAt = Date.now(),
): Promise<void> {
  for (
    let start = 0;
    start < count;
    start += MAX_RECORD_DELETES_PER_TRANSACTION
  ) {
    const end = Math.min(count, start + MAX_RECORD_DELETES_PER_TRANSACTION);
    const batch = orderedRows.slice(start, end);
    const retained = orderedRows.slice(end);
    await runTransaction(
      [STORES.POSTS, STORES.SYNC],
      "readwrite",
      async (tx) => {
        const postStore = tx.objectStore(STORES.POSTS);
        for (const row of batch) postStore.delete(row.id);

        const syncStore = tx.objectStore(STORES.SYNC);
        const scope = `posts:${convId}`;
        const coverage = (await requestResult(syncStore.get(scope))) as
          PostCoverage | undefined;
        if (!coverage) return;
        const first = retained[0];
        const last = retained[retained.length - 1];
        syncStore.put({
          ...coverage,
          lower: first ? { id: first.id, sequence: first.sequence } : null,
          upper: last ? { id: last.id, sequence: last.sequence } : null,
          reached_oldest: false,
          updated_at: updatedAt,
        });
      },
    );
  }
}

function conversationId(
  ref: Pick<Conversation, "type" | "id"> &
    Partial<Pick<Conversation, "conv_id">>,
): string {
  if (ref.conv_id) return ref.conv_id;
  return ref.type === "group"
    ? groupConvId(ref.id)
    : dmConvId(activeMe(), ref.id);
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

function statePending(state: object): 0 | 1 {
  return Object.values(state as Record<string, unknown>).some(
    (value) =>
      !!value &&
      typeof value === "object" &&
      "proposal" in value &&
      !!(value as { proposal?: unknown }).proposal,
  )
    ? 1
    : 0;
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
  const {
    is_bookmarked,
    bookmark_updated_at_ms,
    current_offset,
    current_offset_updated_at,
    current_locator: _locator,
    total_read_seconds,
    last_read_at,
    list_sort_at: _sort,
    content: _content,
    ...core
  } = entry;
  void _locator;
  void _sort;
  void _content;
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
        value: is_bookmarked,
        updatedAt: bookmark_updated_at_ms,
      },
      resume: {
        value: current_offset,
        updatedAt: current_offset_updated_at,
      },
      totalReadSeconds: total_read_seconds ?? 0,
      lastReadAt: last_read_at ?? null,
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
    const group = row as GroupRow;
    return {
      ...group,
      type: "group",
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
  const dm = row as DmRow;
  const peer = await runTransaction(STORES.USERS, "readonly", (tx) =>
    requestResult(tx.objectStore(STORES.USERS).get(access.target_id)),
  );
  const user = peer as ObjectiveUser | undefined;
  return {
    conv_id: dm.conv_id,
    revision: dm.revision,
    type: "dm",
    id: access.target_id,
    handle: user?.handle ?? null,
    name: user?.name ?? "已注销",
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
  entry: Conversation,
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
      has_password: entry.has_password,
      members_hidden: entry.members_hidden,
      admin_only: entry.admin_only,
      no_leave: entry.no_leave,
      last_message: entry.last_message,
      last_at: entry.last_at,
      touched_at: now,
    } satisfies GroupRow);
  } else if (entry.type === "dm" && parsed.type === "dm") {
    tx.objectStore(STORES.DMS).put({
      conv_id: entry.conv_id,
      revision: entry.revision,
      peer_a: parsed.peerA,
      peer_b: parsed.peerB,
      last_message: entry.last_message,
      last_at: entry.last_at,
      touched_at: now,
    } satisfies DmRow);
    tx.objectStore(STORES.USERS).put({
      id: entry.id,
      handle: entry.handle ?? entry.id,
      name: entry.name,
    } satisfies ObjectiveUser);
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
      const previous = (await requestResult(articleStore.get(entry.id))) as
        ObjectiveArticle | undefined;
      if (previous && !Values.equal(previous.value, entity.value)) {
        throw new Error(`Immutable article changed: ${entry.id}`);
      }
      articleStore.put(
        previous ? { ...previous, touched_at: Date.now() } : entity,
      );
      if (entry.user_id) {
        tx.objectStore(STORES.USERS).put({
          id: entry.user_id,
          handle: entry.handle ?? entry.user_id,
          name: entry.username ?? "已注销",
        } satisfies ObjectiveUser);
      }
      const accessStore = tx.objectStore(STORES.ME_ACCESS);
      const currentAccess = (await requestResult(
        accessStore.get([meId, "article", entry.id]),
      )) as ArticleAccessRow | undefined;
      const memberships = (currentAccess?.memberships ?? []).filter(
        (item) =>
          item.view !== membership.view ||
          item.group_id !== membership.group_id,
      );
      memberships.push(membership);
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
): Promise<ArticleWithMeta | null> {
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
  const bookmark = Values.resolved(state.bookmark);
  const resume = Values.resolved(state.resume);
  const membership = access.memberships[0];
  return {
    ...row.value,
    is_bookmarked: bookmark.value,
    bookmark_updated_at_ms: bookmark.updatedAt,
    current_offset: resume.value,
    current_offset_updated_at: resume.updatedAt,
    current_locator: null,
    total_read_seconds: state.total_read_seconds,
    last_read_at: state.last_read_at,
    ...(membership?.sort_at ? { list_sort_at: membership.sort_at } : {}),
  } as ArticleWithMeta;
}

export function conversationRetentionCutoff(
  policy: ConversationDownloadPolicy,
  now = Date.now(),
): number | null {
  const days = CONVERSATION_RETENTION_DAYS[policy];
  return days ? now - days * 86_400_000 : null;
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
    const row: MeRow = {
      me_id: user.id,
      user,
      session_token: token,
      updated_at: Date.now(),
    };
    await runTransaction(
      [STORES.GLOBALS, STORES.ME],
      "readwrite",
      async (tx) => {
        const meStore = tx.objectStore(STORES.ME);
        for (const previous of (await requestResult(
          meStore.getAll(),
        )) as MeRow[]) {
          if (previous.me_id !== user.id && previous.session_token) {
            meStore.put({ ...previous, session_token: null });
          }
        }
        meStore.put(row);
        tx.objectStore(STORES.GLOBALS).put({
          key: GLOBAL_KEYS.ACTIVE_ME,
          value: user.id,
        });
      },
    );
    userScope = user.id;
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
    userScope = "anonymous";
  },
};

export const offlineRepository = {
  setUserScope(userId: string | null): void {
    userScope = userId || "anonymous";
  },

  async getVersionedValue<T>(namespace: string, id: string) {
    const key = `${namespace}:${id}`;
    return runTransaction(STORES.ME_STATE, "readonly", async (tx) => {
      const row = (await requestResult(
        tx.objectStore(STORES.ME_STATE).get([activeMe(), key]),
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
    const meId = activeMe();
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
          .getAll(IDBKeyRange.only([activeMe(), 1])),
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

  async saveConversations(entries: Conversation[]): Promise<void> {
    const meId = activeMe();
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
      activeMe(),
      "conversation",
    )) as ConversationAccessRow[];
    const entries = await Promise.all(rows.map(materializeConversation));
    return sortConversations(
      entries.filter((value): value is Conversation => !!value),
    );
  },

  async upsertConversation(entry: Conversation): Promise<void> {
    const meId = activeMe();
    await runTransaction(
      [
        STORES.GROUPS,
        STORES.DMS,
        STORES.USERS,
        STORES.ME_ACCESS,
        STORES.ME_CONV_STATE,
      ],
      "readwrite",
      (tx) => upsertConversationInTransaction(tx, meId, entry),
    );
  },

  async removeConversation(
    ref: Pick<Conversation, "type" | "id">,
  ): Promise<void> {
    const convId = conversationId(ref);
    await runTransaction(
      [STORES.ME_ACCESS, STORES.ME_CONV_STATE],
      "readwrite",
      (tx) => {
        tx.objectStore(STORES.ME_ACCESS).delete([
          activeMe(),
          "conversation",
          convId,
        ]);
        tx.objectStore(STORES.ME_CONV_STATE).delete([activeMe(), convId]);
      },
    );
  },

  async saveGroupMembers(
    groupId: string,
    payload: GroupMembersAccessRow["snapshot"],
  ): Promise<void> {
    await runTransaction(
      [STORES.ME_ACCESS, STORES.USERS],
      "readwrite",
      (tx) => {
        tx.objectStore(STORES.ME_ACCESS).put({
          me_id: activeMe(),
          kind: "group-members",
          object_id: groupId,
          snapshot: payload,
          snapshot_at: Date.now(),
        } satisfies GroupMembersAccessRow);
        const users = tx.objectStore(STORES.USERS);
        for (const member of payload.members) {
          users.put({
            id: member.id,
            handle: member.handle,
            name: member.username,
          } satisfies ObjectiveUser);
        }
      },
    );
  },

  async getGroupMembers(groupId: string) {
    return runTransaction(STORES.ME_ACCESS, "readonly", async (tx) => {
      const conversation = await requestResult(
        tx
          .objectStore(STORES.ME_ACCESS)
          .get([activeMe(), "conversation", groupConvId(groupId)]),
      );
      if (!conversation) return null;
      const row = await requestResult(
        tx
          .objectStore(STORES.ME_ACCESS)
          .get([activeMe(), "group-members", groupId]),
      );
      return (row as GroupMembersAccessRow | undefined)?.snapshot ?? null;
    });
  },

  async setConversationFlag(
    ref: Pick<Conversation, "type" | "id">,
    field: "pinned" | "muted",
    value: boolean,
  ): Promise<VersionedValue<boolean>> {
    const meId = activeMe();
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
    const meId = activeMe();
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
            .getAll(IDBKeyRange.only([activeMe(), 1])),
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
    const state = await getConversationState(activeMe(), conversationId(ref));
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
    const meId = activeMe();
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
    const meId = activeMe();
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
        proposal:
          proposal &&
          (merge === "furthest"
            ? proposal.value.sequence > remote.sequence
            : proposal.updated_at > remote.updatedAt)
            ? proposal
            : null,
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
    incoming: Post[],
    options: {
      extendCoverage?: boolean;
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
        let lower: { id: string; sequence: number } | null = null;
        let upper: { id: string; sequence: number } | null = null;
        for (const post of incoming) {
          if (
            !Number.isSafeInteger(post.sequence) ||
            (post.sequence ?? 0) <= 0
          ) {
            throw new Error(`Post ${post.id} is missing its required sequence`);
          }
          const previous = (await requestResult(store.get(post.id))) as
            StoredPost | undefined;
          const insidePublishedWindow =
            !!current?.lower &&
            !!current.upper &&
            post.sequence >= current.lower.sequence &&
            post.sequence <= current.upper.sequence;
          if (
            options.extendCoverage !== true &&
            !previous &&
            !insidePublishedWindow
          ) {
            continue;
          }
          if (previous && previous.revision > post.revision) continue;
          if (
            previous &&
            previous.revision === post.revision &&
            !Values.equal(
              { ...previous, size: 0, touched_at: 0, eviction_tier: 0 },
              { ...post, size: 0, touched_at: 0, eviction_tier: 0 },
            )
          ) {
            throw new Error(`Post revision collision: ${post.id}`);
          }
          const row: StoredPost = {
            ...post,
            sequence: post.sequence!,
            size: Values.size(post),
            touched_at: Date.now(),
            eviction_tier: 0,
          };
          store.put(row);
          if (!lower || row.sequence < lower.sequence) {
            lower = { id: row.id, sequence: row.sequence };
          }
          if (!upper || row.sequence > upper.sequence) {
            upper = { id: row.id, sequence: row.sequence };
          }
        }
        if (options.extendCoverage !== true) return;
        syncStore.put({
          scope,
          kind: "posts",
          conv_id: convId,
          known_revision: current?.known_revision ?? 0,
          lower:
            !current?.lower ||
            (lower && lower.sequence < current.lower.sequence)
              ? lower
              : current.lower,
          upper:
            !current?.upper ||
            (upper && upper.sequence > current.upper.sequence)
              ? upper
              : current.upper,
          reached_oldest:
            (current?.reached_oldest ?? false) || !!options.reachedOldest,
          reached_newest:
            (current?.reached_newest ?? false) || !!options.reachedNewest,
          updated_at: Date.now(),
        } satisfies PostCoverage);
      },
    );
    await this.trimConversationPosts(ref);
  },

  async applyPostVersion(post: Post, liveAppend = false): Promise<void> {
    const parsed = parseConvId(post.conv_id);
    if (!parsed) return;
    const ref =
      parsed.type === "group"
        ? { type: "group" as const, id: parsed.groupId, conv_id: post.conv_id }
        : {
            type: "dm" as const,
            id: parsed.peerA === activeMe() ? parsed.peerB : parsed.peerA,
            conv_id: post.conv_id,
          };
    const coverage = await postCoverage(post.conv_id);
    const mayExtendNewest =
      liveAppend &&
      !!coverage?.reached_newest &&
      !!coverage.upper &&
      post.sequence > coverage.upper.sequence;
    await this.savePosts(ref, [post], {
      extendCoverage: mayExtendNewest,
      reachedNewest: mayExtendNewest,
    });
  },

  async reconcilePostPage(
    ref: Pick<Conversation, "type" | "id"> &
      Partial<Pick<Conversation, "conv_id">>,
    incoming: Post[],
    page: {
      beforeId?: string;
      afterId?: string;
      exhausted: boolean;
    },
  ): Promise<void> {
    const convId = conversationId(ref);
    const coverage = await postCoverage(convId);
    const cursorId = page.beforeId ?? page.afterId;
    let connected = !coverage;
    if (coverage && cursorId) {
      const anchor = (await runTransaction(STORES.POSTS, "readonly", (tx) =>
        requestResult(tx.objectStore(STORES.POSTS).get(cursorId)),
      )) as StoredPost | undefined;
      connected = anchor?.conv_id === convId;
    } else if (coverage && !cursorId) {
      const ids = new Set((await this.getPosts(ref)).map((post) => post.id));
      connected = incoming.some((post) => ids.has(post.id));
      if (!connected) await clearConversationPostWindow(convId);
      connected = true;
    }
    if (!connected) return;
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
        const current = (await requestResult(store.get(`posts:${convId}`))) as
          PostCoverage | undefined;
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

  async advancePostRevision(convId: string, revision: number): Promise<void> {
    const scope = `posts:${convId}`;
    await runTransaction(STORES.SYNC, "readwrite", async (tx) => {
      const store = tx.objectStore(STORES.SYNC);
      const current = (await requestResult(store.get(scope))) as
        PostCoverage | undefined;
      store.put({
        scope,
        kind: "posts",
        conv_id: convId,
        known_revision: Math.max(current?.known_revision ?? 0, revision),
        lower: current?.lower ?? null,
        upper: current?.upper ?? null,
        reached_oldest: current?.reached_oldest ?? false,
        reached_newest: current?.reached_newest ?? false,
        updated_at: Date.now(),
      } satisfies PostCoverage);
    });
  },

  async getKnownPostRevision(convId: string): Promise<number> {
    return (await postCoverage(convId))?.known_revision ?? 0;
  },

  async reconcilePostRevisions(
    ref: Pick<Conversation, "type" | "id"> &
      Partial<Pick<Conversation, "conv_id">>,
    incoming: Post[],
    revision: number,
  ): Promise<void> {
    const convId = conversationId(ref);
    const coverage = await postCoverage(convId);
    await this.savePosts(ref, incoming, { extendCoverage: false });
    if (coverage?.reached_newest && coverage.upper) {
      const appended = incoming
        .filter((post) => post.sequence > coverage.upper!.sequence)
        .sort((left, right) => left.sequence - right.sequence);
      if (appended.length) {
        await this.savePosts(ref, appended, {
          extendCoverage: true,
          reachedNewest: true,
        });
      }
    }
    await this.advancePostRevision(convId, revision);
  },

  async getPosts(
    ref: Pick<Conversation, "type" | "id"> &
      Partial<Pick<Conversation, "conv_id">>,
  ): Promise<Post[]> {
    const convId = conversationId(ref);
    return runTransaction(
      [STORES.ME_ACCESS, STORES.POSTS],
      "readonly",
      async (tx) => {
        const access = await requestResult(
          tx
            .objectStore(STORES.ME_ACCESS)
            .get([activeMe(), "conversation", convId]),
        );
        if (!access) return [];
        const rows = (await requestResult(
          tx
            .objectStore(STORES.POSTS)
            .index("by-conversation-sequence")
            .getAll(
              IDBKeyRange.bound([convId, 0], [convId, Number.MAX_SAFE_INTEGER]),
            ),
        )) as StoredPost[];
        return rows.map(
          ({ size: _s, touched_at: _t, eviction_tier: _e, ...post }) => {
            void _s;
            void _t;
            void _e;
            return post;
          },
        );
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
              IDBKeyRange.bound([convId, 0], [convId, Number.MAX_SAFE_INTEGER]),
            ),
        )) as StoredPost[],
    );
    const deleteCount =
      cutoff === null
        ? Math.max(0, rows.length - 200)
        : rows.findIndex((row) => Date.parse(row.created_at) >= cutoff);
    const normalizedCount =
      cutoff !== null && deleteCount < 0 ? rows.length : deleteCount;
    await deleteConversationPostPrefix(convId, rows, normalizedCount);
  },

  async getConversationPolicy(ref: Pick<Conversation, "type" | "id">) {
    const row = await runTransaction(STORES.SAVE, "readonly", (tx) =>
      requestResult(
        tx
          .objectStore(STORES.SAVE)
          .get([activeMe(), "conversation", conversationId(ref)]),
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
      claimant: activeMe(),
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
        (row) => row.claimant === activeMe() && row.kind === "conversation",
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
      activeMe(),
      "conversation",
      conversationId(ref),
    ];
    await runTransaction(STORES.SAVE, "readwrite", async (tx) => {
      const store = tx.objectStore(STORES.SAVE);
      const row = (await requestResult(store.get(key))) as
        RetentionRow | undefined;
      if (row) store.put({ ...row, materialized: true, missing_reason: null });
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
      await upsertArticle(activeMe(), entry, {
        ...membership,
        sort_at: entry.list_sort_at ?? entry.created_at,
      });
    }
  },

  async getArticleList(): Promise<ArticleWithMeta[]> {
    const rows = (await accessRows(
      activeMe(),
      "article",
    )) as ArticleAccessRow[];
    const articles = await Promise.all(rows.map(materializeArticle));
    return articles
      .filter((value): value is ArticleWithMeta => !!value)
      .sort((left, right) => right.created_at.localeCompare(left.created_at));
  },

  async getSavedArticleList(): Promise<ArticleWithMeta[]> {
    const entries = await this.getArticleList();
    const result: ArticleWithMeta[] = [];
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
    await runTransaction(STORES.SYNC, "readwrite", async (tx) => {
      type Boundary = { sortAt: string; id: string };
      type ArticleCoverageDetail = {
        newest: Boundary | null;
        oldest: Boundary | null;
        reachedNewest: boolean;
        reachedOldest: boolean;
      };
      const boundary = (entry: ArticleWithMeta | undefined): Boundary | null =>
        entry
          ? {
              sortAt: entry.list_sort_at ?? entry.created_at,
              id: entry.id,
            }
          : null;
      const same = (left: Boundary | null, right: Boundary | null) =>
        !!left &&
        !!right &&
        left.id === right.id &&
        left.sortAt === right.sortAt;

      const store = tx.objectStore(STORES.SYNC);
      const scope = `me:${activeMe()}:articles:${page.view}:${page.groupId ?? "all"}`;
      const current = (await requestResult(store.get(scope))) as
        { detail?: ArticleCoverageDetail } | undefined;
      const first = boundary(entries[0]);
      const last = boundary(entries[entries.length - 1]);
      let detail: ArticleCoverageDetail | null = null;
      if (!current?.detail && page.cursor === null) {
        detail = {
          newest: first,
          oldest: last,
          reachedNewest: page.direction === "after" || !page.hasMore,
          reachedOldest: page.direction === "before" || !page.hasMore,
        };
      } else if (
        current?.detail &&
        page.direction === "after" &&
        same(current.detail.oldest, page.cursor)
      ) {
        detail = {
          ...current.detail,
          oldest: last ?? current.detail.oldest,
          reachedOldest: current.detail.reachedOldest || !page.hasMore,
        };
      } else if (
        current?.detail &&
        page.direction === "before" &&
        same(current.detail.newest, page.cursor)
      ) {
        detail = {
          ...current.detail,
          newest: first ?? current.detail.newest,
          reachedNewest: current.detail.reachedNewest || !page.hasMore,
        };
      }
      // An isolated cursor page is useful cached data but proves no contiguous
      // range, so it deliberately leaves the coverage row unchanged.
      if (!detail) return;
      store.put({
        scope,
        kind: "article-list",
        me_id: activeMe(),
        complete: detail.reachedNewest && detail.reachedOldest,
        updated_at: Date.now(),
        detail,
      });
    });
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
          activeMe(),
          "article",
          articleId,
        ]);
        tx.objectStore(STORES.ME_ARTICLE_STATE).delete([activeMe(), articleId]);
      },
    );
  },

  async purgeArticle(articleId: string): Promise<void> {
    const related = await runTransaction(
      [
        STORES.ARTICLE_SEGMENTS,
        STORES.ME_ACCESS,
        STORES.ME_ARTICLE_STATE,
        STORES.SAVE,
      ],
      "readonly",
      async (tx) => ({
        segments: await requestResult(
          tx
            .objectStore(STORES.ARTICLE_SEGMENTS)
            .index("by-article")
            .getAllKeys(IDBKeyRange.only(articleId)),
        ),
        access: await requestResult(
          tx
            .objectStore(STORES.ME_ACCESS)
            .index("by-object")
            .getAllKeys(IDBKeyRange.only(["article", articleId])),
        ),
        states: (
          (await requestResult(
            tx.objectStore(STORES.ME_ARTICLE_STATE).getAll(),
          )) as ArticleUserStateRow[]
        )
          .filter((row) => row.article_id === articleId)
          .map((row) => [row.me_id, row.article_id] as IDBValidKey),
        saves: await requestResult(
          tx
            .objectStore(STORES.SAVE)
            .index("by-resource")
            .getAllKeys(IDBKeyRange.only(["article", articleId])),
        ),
      }),
    );
    await runTransaction(STORES.ARTICLES, "readwrite", (tx) => {
      tx.objectStore(STORES.ARTICLES).delete(articleId);
    });
    await deleteKeysBatched(STORES.ARTICLE_SEGMENTS, related.segments);
    await deleteKeysBatched(STORES.ME_ACCESS, related.access);
    await deleteKeysBatched(STORES.ME_ARTICLE_STATE, related.states);
    await deleteKeysBatched(STORES.SAVE, related.saves);
  },

  async saveArticleMeta(
    article: ArticleWithMeta,
    membership: Pick<ArticleMembership, "view" | "group_id"> = {
      view: "direct",
      group_id: null,
    },
  ): Promise<void> {
    await upsertArticle(activeMe(), article, {
      ...membership,
      sort_at: article.list_sort_at ?? article.created_at,
    });
  },

  async getArticleMeta(articleId: string): Promise<ArticleWithMeta | null> {
    const row = await runTransaction(STORES.ME_ACCESS, "readonly", (tx) =>
      requestResult(
        tx
          .objectStore(STORES.ME_ACCESS)
          .get([activeMe(), "article", articleId]),
      ),
    );
    return row ? materializeArticle(row as ArticleAccessRow) : null;
  },

  async getArticleProgress(
    articleId: string,
  ): Promise<ReadingProgressVersion | null> {
    const state = await getArticleState(activeMe(), articleId);
    const value = Values.resolved(state.resume);
    return {
      offset: value.value,
      updatedAt: value.updatedAt,
      synced: !value.pending,
    };
  },

  async setArticleBookmark(articleId: string, value: boolean) {
    const meId = activeMe();
    return runTransaction(STORES.ME_ARTICLE_STATE, "readwrite", async (tx) => {
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
    });
  },

  async reconcileArticleBookmark(
    articleId: string,
    remote: { value: boolean; updatedAt: number },
  ) {
    const meId = activeMe();
    return runTransaction(STORES.ME_ARTICLE_STATE, "readwrite", async (tx) => {
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
    });
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
          .getAll(IDBKeyRange.only([activeMe(), 1])),
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
    const meId = activeMe();
    return runTransaction(STORES.ME_ARTICLE_STATE, "readwrite", async (tx) => {
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
      return { offset: value.value, updatedAt: value.updatedAt, synced: false };
    });
  },

  async reconcileArticleProgress(
    articleId: string,
    remote: { offset: number; updatedAt: number },
    merge: "override" | "furthest" = "override",
  ) {
    const meId = activeMe();
    return runTransaction(STORES.ME_ARTICLE_STATE, "readwrite", async (tx) => {
      const store = tx.objectStore(STORES.ME_ARTICLE_STATE);
      const current =
        ((await requestResult(store.get([meId, articleId]))) as
          ArticleUserStateRow | undefined) ??
        defaultArticleState(meId, articleId);
      if (merge === "furthest") {
        current.resume = Values.assignment(remote.offset, remote.updatedAt);
        current.furthest = Values.assignment(remote.offset, remote.updatedAt);
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
    });
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
          .getAll(IDBKeyRange.only([activeMe(), 1])),
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
    const row = await runTransaction(STORES.SAVE, "readonly", (tx) =>
      requestResult(
        tx.objectStore(STORES.SAVE).get([activeMe(), "article", articleId]),
      ),
    );
    const policy = Policies.article(
      (row as RetentionRow | undefined)?.mode === "retained"
        ? {
            mode: "retained",
            days: Number((row as RetentionRow).keep_after_ms),
            expiresAt: (row as RetentionRow).protected_until,
          }
        : null,
    );
    if (policy.mode === "retained" && policy.expiresAt <= Date.now()) {
      await this.setArticlePolicy(articleId, { mode: "auto" });
      return { mode: "auto" };
    }
    return policy;
  },

  async setArticlePolicy(articleId: string, policy: ArticleDownloadPolicy) {
    const normalized = Policies.article(policy);
    const row: RetentionRow = {
      claimant: activeMe(),
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
        .filter((row) => row.claimant === activeMe() && row.kind === "article")
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
    const key: [string, "article", string] = [activeMe(), "article", articleId];
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
      if (previous && !Values.equal(previous.value, data)) {
        throw new Error(
          `Immutable article segment changed: ${articleId}:${startOffset}`,
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
    const state = await getConversationState(activeMe(), conversationId(ref));
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
    const meId = activeMe();
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
            .getAll(IDBKeyRange.only([activeMe(), 1])),
        )) as ConversationUserStateRow[],
    );
    return rows.flatMap((row) => {
      if (!Values.resolved(row.draft).pending) return [];
      const entry = entries.find((item) => item.conv_id === row.conv_id);
      return entry ? [{ type: entry.type, id: entry.id }] : [];
    });
  },
};

export async function handleOfflineQuotaPressure(
  bytesToFree: number,
  allowProtected = false,
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
  const articleProtected = (articleId: string) =>
    claims.some(
      (claim) =>
        claim.kind === "article" &&
        claim.object_id === articleId &&
        claim.mode === "retained" &&
        claim.protected_until > now,
    );

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
  const segmentKeys: IDBValidKey[] = [];
  for (const row of segmentRows) {
    if (freed >= bytesToFree) break;
    const protectedByClaim = articleProtected(row.article_id);
    if (!allowProtected && protectedByClaim) continue;
    segmentKeys.push([row.article_id, row.start_offset]);
    freed += row.size;
    evictedArticles.add(row.article_id);
  }
  await deleteKeysBatched(STORES.ARTICLE_SEGMENTS, segmentKeys);

  // Extent files are whole-object eviction units. Never inspect their payloads.
  if (freed < bytesToFree) {
    const files = (await extentFiles.list("article:"))
      .map((head) => ({ head, articleId: FileIds.articleId(head.id) }))
      .filter(
        (item): item is { head: typeof item.head; articleId: string } =>
          !!item.articleId,
      )
      .sort((left, right) => left.head.created_at - right.head.created_at);
    for (const { head, articleId } of files) {
      if (freed >= bytesToFree) break;
      if (!allowProtected && articleProtected(articleId)) continue;
      await extentFiles.delete(head.id);
      freed += head.size;
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
      for (const row of rows) {
        if (freed >= bytesToFree) break;
        const protectedByClaim =
          cutoff !== null && Date.parse(row.created_at) >= cutoff;
        if (protectedByClaim && !allowProtected) break;
        deleteCount += 1;
        freed += row.size;
        if (protectedByClaim) evictedConversations.add(convId);
      }
      if (!deleteCount) continue;
      await deleteConversationPostPrefix(convId, rows, deleteCount, now);
    }
  }

  if (evictedArticles.size || evictedConversations.size) {
    await runTransaction(STORES.SAVE, "readwrite", async (tx) => {
      const store = tx.objectStore(STORES.SAVE);
      for (const claim of claims) {
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
