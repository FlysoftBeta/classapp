import type { ArticleWithMeta, Conversation, Post } from "@/shared/types/api";
import { resourceManager } from "./ResourceManager";
import {
  chooseFurthestRead,
  chooseLatestTimestamped,
} from "@/shared/sync/arbitration";

export type ConversationDownloadPolicy = "auto" | "week" | "half-year";
export type ArticleDownloadPolicy =
  { mode: "auto" } | { mode: "retained"; days: 1 | 7 | 180; expiresAt: number };

export const ARTICLE_RETENTION_DAYS = [1, 7, 180] as const;
export const CONVERSATION_RETENTION_DAYS = {
  auto: 0,
  week: 7,
  "half-year": 180,
} as const satisfies Record<ConversationDownloadPolicy, number>;

function normalizeConversationPolicy(
  value: unknown,
): ConversationDownloadPolicy {
  return value === "week" || value === "half-year" ? value : "auto";
}

function normalizeArticlePolicy(policy: unknown): ArticleDownloadPolicy {
  if (!policy || typeof policy !== "object") return { mode: "auto" };
  const candidate = policy as {
    mode?: string;
    days?: number;
    expiresAt?: number;
  };
  if (
    candidate.mode !== "retained" ||
    !ARTICLE_RETENTION_DAYS.includes(candidate.days as 1 | 7 | 180) ||
    typeof candidate.expiresAt !== "number"
  )
    return { mode: "auto" };
  return {
    mode: "retained",
    days: candidate.days as 1 | 7 | 180,
    expiresAt: candidate.expiresAt,
  };
}

function timestamp(value: string): number {
  return Date.parse(value.endsWith("Z") ? value : `${value}Z`);
}

export function conversationRetentionCutoff(
  policy: ConversationDownloadPolicy,
  now = Date.now(),
): number | null {
  const days = CONVERSATION_RETENTION_DAYS[policy];
  return days ? now - days * 86_400_000 : null;
}

export interface DraftVersion {
  content: string;
  updatedAt: number;
  syncedAt: number | null;
}

export interface VersionedValue<T> {
  value: T;
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

const PREFIX = "offline:v1";
let userScope = "anonymous";
const keyLocks = new Map<string, Promise<void>>();

async function withKeyLock<T>(storageKey: string, run: () => Promise<T>) {
  const previous = keyLocks.get(storageKey) ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  keyLocks.set(storageKey, tail);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (keyLocks.get(storageKey) === tail) keyLocks.delete(storageKey);
  }
}

function key(kind: string, id = ""): string {
  return `${PREFIX}:${userScope}:${kind}${id ? `:${id}` : ""}`;
}

function conversationId(ref: Pick<Conversation, "type" | "id">): string {
  return `${ref.type}:${ref.id}`;
}

function sortedPosts(posts: Post[]): Post[] {
  return [...posts].sort((a, b) => a.created_at.localeCompare(b.created_at));
}

function nextUpdatedAt(current?: { updatedAt: number } | null): number {
  return Math.max(Date.now(), (current?.updatedAt ?? 0) + 1);
}

export const offlineRepository = {
  setUserScope(userId: string | null) {
    userScope = userId || "anonymous";
  },

  async getVersionedValue<T>(namespace: string, id: string) {
    return resourceManager.getJson<VersionedValue<T>>(
      key(`version:${namespace}`, id),
    );
  },
  async setVersionedValue<T>(
    namespace: string,
    id: string,
    value: T,
    options?: { updatedAt?: number; synced?: boolean },
  ) {
    const storageKey = key(`version:${namespace}`, id);
    return withKeyLock(storageKey, async () => {
      const current =
        await resourceManager.getJson<VersionedValue<T>>(storageKey);
      const updatedAt = options?.updatedAt ?? nextUpdatedAt(current);
      if (current && current.updatedAt > updatedAt) return current;
      const next: VersionedValue<T> = {
        value,
        updatedAt,
        syncedAt: options?.synced ? updatedAt : null,
      };
      await resourceManager.putJson(storageKey, next, "persisted");
      return next;
    });
  },
  async reconcileVersionedValue<T>(
    namespace: string,
    id: string,
    remote: { value: T; updatedAt: number },
  ) {
    const storageKey = key(`version:${namespace}`, id);
    return withKeyLock(storageKey, async () => {
      const current =
        await resourceManager.getJson<VersionedValue<T>>(storageKey);
      const winner = chooseLatestTimestamped(current, remote);
      if (winner === current) return current;
      const canonical: VersionedValue<T> = {
        value: remote.value,
        updatedAt: remote.updatedAt,
        syncedAt: remote.updatedAt,
      };
      await resourceManager.putJson(storageKey, canonical, "persisted");
      return canonical;
    });
  },
  async getPendingVersionedValues<T>(namespace: string) {
    const prefix = key(`version:${namespace}`);
    const result: Array<{ id: string; version: VersionedValue<T> }> = [];
    for (const storageKey of await resourceManager.keys(prefix)) {
      const version =
        await resourceManager.getJson<VersionedValue<T>>(storageKey);
      if (version?.syncedAt === null)
        result.push({ id: storageKey.slice(prefix.length + 1), version });
    }
    return result;
  },

  async getConversationReadVersion(
    ref: Pick<Conversation, "type" | "id">,
  ): Promise<VersionedValue<ConversationReadValue> | null> {
    const id = `${conversationId(ref)}:read`;
    const stored = await this.getVersionedValue<ConversationReadValue | string>(
      "conversation-config",
      id,
    );
    if (!stored) return null;
    if (typeof stored.value !== "string") {
      return stored as VersionedValue<ConversationReadValue>;
    }
    const cachedEntry = (await this.getConversations()).find(
      (entry) => entry.type === ref.type && entry.id === ref.id,
    );
    const cachedPost = (await this.getPosts(ref)).find(
      (post) => post.id === stored.value,
    );
    return {
      ...stored,
      value: {
        postId: stored.value,
        sequence:
          cachedPost?.sequence ??
          (cachedEntry?.last_read_post_id === stored.value
            ? cachedEntry.last_read_post_sequence
            : 0),
      },
    };
  },

  async setPendingConversationRead(
    ref: Pick<Conversation, "type" | "id">,
    postId: string,
    knownSequence?: number,
  ): Promise<{
    version: VersionedValue<ConversationReadValue>;
    changed: boolean;
  }> {
    const id = `${conversationId(ref)}:read`;
    const storageKey = key("version:conversation-config", id);
    return withKeyLock(storageKey, async () => {
      const stored =
        await resourceManager.getJson<
          VersionedValue<ConversationReadValue | string>
        >(storageKey);
      const entries = await this.getConversations();
      const cachedEntry = entries.find(
        (entry) => entry.type === ref.type && entry.id === ref.id,
      );
      const cachedPosts = await this.getPosts(ref);
      const targetSequence =
        knownSequence ??
        cachedPosts.find((post) => post.id === postId)?.sequence ??
        0;
      const storedPostId =
        typeof stored?.value === "string"
          ? stored.value
          : (stored?.value.postId ?? null);
      const storedSequence =
        typeof stored?.value === "string"
          ? (cachedPosts.find((post) => post.id === stored.value)?.sequence ??
            0)
          : (stored?.value.sequence ?? 0);
      const cachedSequence = cachedEntry?.last_read_post_sequence ?? 0;
      if (
        targetSequence > 0 &&
        Math.max(storedSequence, cachedSequence) >= targetSequence
      ) {
        return {
          version: {
            value: {
              postId:
                storedSequence >= cachedSequence
                  ? storedPostId
                  : (cachedEntry?.last_read_post_id ?? null),
              sequence: Math.max(storedSequence, cachedSequence),
            },
            updatedAt:
              stored?.updatedAt ?? cachedEntry?.read_updated_at_ms ?? 0,
            syncedAt: stored?.syncedAt ?? cachedEntry?.read_updated_at_ms ?? 0,
          },
          changed: false,
        };
      }
      const updatedAt = nextUpdatedAt(stored);
      const version: VersionedValue<ConversationReadValue> = {
        value: { postId, sequence: targetSequence },
        updatedAt,
        syncedAt: null,
      };
      await resourceManager.putJson(storageKey, version, "persisted");
      if (
        cachedEntry &&
        (targetSequence > 0 || cachedEntry.last_read_post_sequence === 0)
      ) {
        await this.upsertConversation({
          ...cachedEntry,
          last_read_post_id: postId,
          last_read_post_sequence: targetSequence,
          read_updated_at_ms: updatedAt,
          unread_count: 0,
          first_unread_post_id: null,
        });
      }
      return { version, changed: true };
    });
  },

  async reconcileConversationRead(
    ref: Pick<Conversation, "type" | "id">,
    remote: ConversationReadValue & { updatedAt: number },
  ): Promise<VersionedValue<ConversationReadValue>> {
    const id = `${conversationId(ref)}:read`;
    const storageKey = key("version:conversation-config", id);
    return withKeyLock(storageKey, async () => {
      const stored =
        await resourceManager.getJson<
          VersionedValue<ConversationReadValue | string>
        >(storageKey);
      const cachedPosts = await this.getPosts(ref);
      const storedValue: ConversationReadValue | null = stored
        ? typeof stored.value === "string"
          ? {
              postId: stored.value,
              sequence:
                cachedPosts.find((post) => post.id === stored.value)
                  ?.sequence ?? 0,
            }
          : stored.value
        : null;
      if (storedValue) {
        const local = { ...storedValue, updatedAt: stored!.updatedAt };
        if (chooseFurthestRead(local, remote) === local) {
          return { ...stored!, value: storedValue };
        }
      }
      const canonical: VersionedValue<ConversationReadValue> = {
        value: { postId: remote.postId, sequence: remote.sequence },
        updatedAt: remote.updatedAt,
        syncedAt: remote.updatedAt,
      };
      await resourceManager.putJson(storageKey, canonical, "persisted");
      return canonical;
    });
  },

  async saveConversations(entries: Conversation[]) {
    await resourceManager.putJson(key("conversations"), entries, "persisted");
  },
  async getConversations() {
    return (
      (await resourceManager.getJson<Conversation[]>(key("conversations"))) ??
      []
    );
  },
  async upsertConversation(entry: Conversation) {
    const entries = await this.getConversations();
    const index = entries.findIndex(
      (item) => item.type === entry.type && item.id === entry.id,
    );
    if (index >= 0) entries[index] = entry;
    else entries.push(entry);
    await this.saveConversations(entries);
  },
  async removeConversation(ref: Pick<Conversation, "type" | "id">) {
    await this.saveConversations(
      (await this.getConversations()).filter(
        (item) => item.type !== ref.type || item.id !== ref.id,
      ),
    );
  },

  async getConversationPolicy(ref: Pick<Conversation, "type" | "id">) {
    const version = await this.getVersionedValue<ConversationDownloadPolicy>(
      "download-policy",
      conversationId(ref),
    );
    if (version) return normalizeConversationPolicy(version.value);
    return normalizeConversationPolicy(
      (await resourceManager.getJson<ConversationDownloadPolicy>(
        key("conversation-policy", conversationId(ref)),
      )) ?? "auto",
    );
  },
  async setConversationPolicy(
    ref: Pick<Conversation, "type" | "id">,
    policy: ConversationDownloadPolicy,
  ) {
    await this.setVersionedValue(
      "download-policy",
      conversationId(ref),
      policy,
    );
    await this.trimConversationPosts(ref);
  },
  async getConversationPolicies() {
    const prefix = key("version:download-policy");
    const result: Array<{
      ref: { type: "group" | "dm"; id: string };
      policy: ConversationDownloadPolicy;
    }> = [];
    for (const storageKey of await resourceManager.keys(prefix)) {
      const suffix = storageKey.slice(prefix.length + 1);
      const separator = suffix.indexOf(":");
      const type = suffix.slice(0, separator);
      const id = suffix.slice(separator + 1);
      const policy = normalizeConversationPolicy(
        (
          await resourceManager.getJson<
            VersionedValue<ConversationDownloadPolicy>
          >(storageKey)
        )?.value,
      );
      if ((type === "group" || type === "dm") && id && policy)
        result.push({ ref: { type, id }, policy });
    }
    const legacyPrefix = key("conversation-policy");
    for (const storageKey of await resourceManager.keys(legacyPrefix)) {
      const suffix = storageKey.slice(legacyPrefix.length + 1);
      const separator = suffix.indexOf(":");
      const type = suffix.slice(0, separator);
      const id = suffix.slice(separator + 1);
      if (result.some((item) => item.ref.type === type && item.ref.id === id))
        continue;
      const policy = normalizeConversationPolicy(
        await resourceManager.getJson<ConversationDownloadPolicy>(storageKey),
      );
      if ((type === "group" || type === "dm") && id && policy)
        result.push({ ref: { type, id }, policy });
    }
    return result;
  },
  async markConversationPolicySynced(ref: Pick<Conversation, "type" | "id">) {
    const id = conversationId(ref);
    const current = await this.getVersionedValue<ConversationDownloadPolicy>(
      "download-policy",
      id,
    );
    const value =
      current?.value ??
      (await resourceManager.getJson<ConversationDownloadPolicy>(
        key("conversation-policy", id),
      ));
    if (value)
      await this.setVersionedValue("download-policy", id, value, {
        updatedAt: current?.updatedAt ?? 0,
        synced: true,
      });
  },
  async savePosts(ref: Pick<Conversation, "type" | "id">, incoming: Post[]) {
    const storageKey = key("posts", conversationId(ref));
    const old = (await resourceManager.getJson<Post[]>(storageKey)) ?? [];
    const merged = new Map(old.map((post) => [post.id, post]));
    for (const post of incoming) merged.set(post.id, post);
    const policy = await this.getConversationPolicy(ref);
    const cutoff = conversationRetentionCutoff(policy);
    const posts = sortedPosts([...merged.values()]).filter(
      (post) => cutoff === null || timestamp(post.created_at) >= cutoff,
    );
    await resourceManager.putJson(
      storageKey,
      policy === "auto" ? posts.slice(-200) : posts,
      policy === "auto" ? "cache" : "persisted",
    );
  },
  async reconcilePostPage(
    ref: Pick<Conversation, "type" | "id">,
    incoming: Post[],
  ) {
    if (!incoming.length) return;
    const sequenced = incoming.filter(
      (post): post is Post & { sequence: number } =>
        typeof post.sequence === "number",
    );
    if (!sequenced.length) {
      await this.savePosts(ref, incoming);
      return;
    }
    const minSequence = Math.min(...sequenced.map((post) => post.sequence));
    const maxSequence = Math.max(...sequenced.map((post) => post.sequence));
    const remoteIds = new Set(incoming.map((post) => post.id));
    const tombstones = (await this.getPosts(ref))
      .filter(
        (post) =>
          typeof post.sequence === "number" &&
          post.sequence >= minSequence &&
          post.sequence <= maxSequence &&
          !remoteIds.has(post.id) &&
          !post.is_deleted,
      )
      .map((post) => ({ ...post, is_deleted: 1 }));
    await this.savePosts(ref, [...incoming, ...tombstones]);
  },
  async getPosts(ref: Pick<Conversation, "type" | "id">) {
    const posts =
      (await resourceManager.getJson<Post[]>(
        key("posts", conversationId(ref)),
      )) ?? [];
    const policy = await this.getConversationPolicy(ref);
    const cutoff = conversationRetentionCutoff(policy);
    if (cutoff === null) return posts;
    const retained = posts.filter(
      (post) => timestamp(post.created_at) >= cutoff,
    );
    if (retained.length !== posts.length) {
      await resourceManager.putJson(
        key("posts", conversationId(ref)),
        retained,
        "persisted",
      );
    }
    return retained;
  },
  async markPostDeleted(
    ref: Pick<Conversation, "type" | "id">,
    postId: string,
  ) {
    const posts = await this.getPosts(ref);
    const post = posts.find((item) => item.id === postId);
    if (!post) return;
    await this.savePosts(ref, [{ ...post, is_deleted: 1 }]);
  },
  async trimConversationPosts(ref: Pick<Conversation, "type" | "id">) {
    const posts = await this.getPosts(ref);
    if (posts.length) await this.savePosts(ref, posts);
  },

  async saveArticleList(
    entries: ArticleWithMeta[],
    retainedIds: string[] = [],
  ) {
    const policyKeys = [
      ...(await resourceManager.keys(key("version:article-policy"))),
      ...(await resourceManager.keys(key("article-policy"))),
    ];
    const explicitIds: string[] = [];
    for (const policyKey of policyKeys) {
      const stored = await resourceManager.getJson<
        VersionedValue<ArticleDownloadPolicy> | ArticleDownloadPolicy
      >(policyKey);
      const policy = stored && "updatedAt" in stored ? stored.value : stored;
      if (normalizeArticlePolicy(policy).mode === "retained")
        explicitIds.push(policyKey.slice(policyKey.lastIndexOf(":") + 1));
    }
    const keep = new Set([...retainedIds, ...explicitIds]);
    const first = entries.slice(0, 200);
    const firstIds = new Set(first.map((item) => item.id));
    const retained = (await this.getArticleList()).filter(
      (item) => keep.has(item.id) && !firstIds.has(item.id),
    );
    await resourceManager.putJson(
      key("articles"),
      [...first, ...retained],
      "persisted",
    );
  },
  async getArticleList() {
    return (
      (await resourceManager.getJson<ArticleWithMeta[]>(key("articles"))) ?? []
    );
  },
  async getSavedArticleList() {
    const saved: ArticleWithMeta[] = [];
    for (const article of await this.getArticleList()) {
      if ((await this.getArticlePolicy(article.id)).mode === "retained")
        saved.push(article);
    }
    return saved;
  },
  async mergeArticleListEntries(entries: ArticleWithMeta[]) {
    const merged = new Map(
      (await this.getArticleList()).map((article) => [article.id, article]),
    );
    for (const entry of entries) merged.set(entry.id, entry);
    const ordered = [...merged.values()].sort((a, b) =>
      b.created_at.localeCompare(a.created_at),
    );
    await this.saveArticleList(ordered);
  },
  async reconcileArticlePage(
    entries: ArticleWithMeta[],
    page: { offset: number; total: number },
  ) {
    const old = await this.getArticleList();
    if (!entries.length) {
      if (page.offset === 0 && page.total === 0) {
        await resourceManager.putJson(key("articles"), [], "persisted");
        await Promise.all(
          old.flatMap((article) => [
            resourceManager.remove(key("article-meta", article.id)),
            resourceManager.remove(key("article-segments", article.id)),
            resourceManager.remove(key("article-progress", article.id)),
          ]),
        );
      }
      return;
    }
    const remoteIds = new Set(entries.map((article) => article.id));
    const removedIds: string[] = [];
    const newest = entries[0]!.created_at;
    const oldest = entries[entries.length - 1]!.created_at;
    const reachesStart = page.offset === 0;
    const reachesEnd = page.offset + entries.length >= page.total;
    const kept = old.filter((article) => {
      if (remoteIds.has(article.id)) return false;
      const atOrBeforeNewest = article.created_at <= newest;
      const atOrAfterOldest = article.created_at >= oldest;
      const covered = reachesStart
        ? reachesEnd
          ? true
          : atOrAfterOldest
        : reachesEnd
          ? atOrBeforeNewest
          : atOrBeforeNewest && atOrAfterOldest;
      if (covered) removedIds.push(article.id);
      return !covered;
    });
    const reconciled = [...kept, ...entries].sort((a, b) =>
      b.created_at.localeCompare(a.created_at),
    );
    await resourceManager.putJson(key("articles"), reconciled, "persisted");
    await Promise.all([
      ...entries.map((article) => this.saveArticleMeta(article)),
      ...removedIds.flatMap((articleId) => [
        resourceManager.remove(key("article-meta", articleId)),
        resourceManager.remove(key("article-segments", articleId)),
        resourceManager.remove(key("article-progress", articleId)),
      ]),
    ]);
  },
  async upsertArticleListEntry(entry: ArticleWithMeta) {
    await this.mergeArticleListEntries([entry]);
    await this.saveArticleMeta(entry);
  },
  async removeArticle(articleId: string) {
    const entries = (await this.getArticleList()).filter(
      (item) => item.id !== articleId,
    );
    await resourceManager.putJson(key("articles"), entries, "persisted");
    await Promise.all([
      resourceManager.remove(key("article-meta", articleId)),
      resourceManager.remove(key("article-segments", articleId)),
      resourceManager.remove(key("article-progress", articleId)),
    ]);
  },
  async saveArticleMeta(article: ArticleWithMeta) {
    await resourceManager.putJson(
      key("article-meta", article.id),
      article,
      "persisted",
    );
  },
  async getArticleMeta(articleId: string) {
    return resourceManager.getJson<ArticleWithMeta>(
      key("article-meta", articleId),
    );
  },
  async getArticleProgress(articleId: string) {
    return resourceManager.getJson<ReadingProgressVersion>(
      key("article-progress", articleId),
    );
  },
  async setPendingArticleProgress(articleId: string, offset: number) {
    const storageKey = key("article-progress", articleId);
    return withKeyLock(storageKey, async () => {
      const current =
        await resourceManager.getJson<ReadingProgressVersion>(storageKey);
      if (current && current.offset === offset && !current.synced)
        return current;
      const next: ReadingProgressVersion = {
        offset,
        updatedAt: nextUpdatedAt(current),
        synced: false,
      };
      await resourceManager.putJson(storageKey, next, "persisted");
      return next;
    });
  },
  async reconcileArticleProgress(
    articleId: string,
    remote: { offset: number; updatedAt: number },
  ) {
    const storageKey = key("article-progress", articleId);
    return withKeyLock(storageKey, async () => {
      const current =
        await resourceManager.getJson<ReadingProgressVersion>(storageKey);
      const localCandidate = current
        ? { value: current.offset, updatedAt: current.updatedAt }
        : null;
      const winner = chooseLatestTimestamped(localCandidate, {
        value: remote.offset,
        updatedAt: remote.updatedAt,
      });
      if (winner === localCandidate) return current!;
      const canonical: ReadingProgressVersion = {
        offset: remote.offset,
        updatedAt: remote.updatedAt,
        synced: true,
      };
      await resourceManager.putJson(storageKey, canonical, "persisted");
      return canonical;
    });
  },
  async getPendingArticleProgress() {
    const prefix = key("article-progress");
    const result: Array<{
      articleId: string;
      offset: number;
      updatedAt: number;
    }> = [];
    for (const storageKey of await resourceManager.keys(prefix)) {
      const progress =
        await resourceManager.getJson<ReadingProgressVersion>(storageKey);
      if (progress && !progress.synced)
        result.push({
          articleId: storageKey.slice(prefix.length + 1),
          offset: progress.offset,
          updatedAt: progress.updatedAt,
        });
    }
    return result;
  },
  async getArticlePolicy(articleId: string): Promise<ArticleDownloadPolicy> {
    const version = await this.getVersionedValue<ArticleDownloadPolicy>(
      "article-policy",
      articleId,
    );
    const policy = version
      ? normalizeArticlePolicy(version.value)
      : normalizeArticlePolicy(
          await resourceManager.getJson<ArticleDownloadPolicy>(
            key("article-policy", articleId),
          ),
        );
    if (policy.mode === "retained" && policy.expiresAt <= Date.now()) {
      await this.setArticlePolicy(articleId, { mode: "auto" });
      await resourceManager.remove(key("article-segments", articleId));
      return { mode: "auto" };
    }
    return policy;
  },
  async setArticlePolicy(articleId: string, policy: ArticleDownloadPolicy) {
    const normalized = normalizeArticlePolicy(policy);
    await this.setVersionedValue("article-policy", articleId, normalized);
    const effective = await this.getArticlePolicy(articleId);
    const storageKey = key("article-segments", articleId);
    const segments =
      await resourceManager.getJson<Record<string, unknown>>(storageKey);
    if (segments) {
      await resourceManager.putJson(
        storageKey,
        segments,
        effective.mode === "auto" ? "cache" : "persisted",
      );
    }
  },
  async getArticlePolicies() {
    const prefix = key("version:article-policy");
    const result: Array<{ articleId: string; policy: ArticleDownloadPolicy }> =
      [];
    for (const storageKey of await resourceManager.keys(prefix)) {
      const articleId = storageKey.slice(prefix.length + 1);
      const policy = normalizeArticlePolicy(
        (
          await resourceManager.getJson<VersionedValue<ArticleDownloadPolicy>>(
            storageKey,
          )
        )?.value ?? null,
      );
      if (articleId && policy) result.push({ articleId, policy });
    }
    const legacyPrefix = key("article-policy");
    for (const storageKey of await resourceManager.keys(legacyPrefix)) {
      const articleId = storageKey.slice(legacyPrefix.length + 1);
      if (result.some((item) => item.articleId === articleId)) continue;
      const policy = normalizeArticlePolicy(
        await resourceManager.getJson<ArticleDownloadPolicy>(storageKey),
      );
      if (articleId) result.push({ articleId, policy });
    }
    return result;
  },
  async markArticlePolicySynced(articleId: string) {
    const current = await this.getVersionedValue<ArticleDownloadPolicy>(
      "article-policy",
      articleId,
    );
    const value =
      current?.value ??
      (await resourceManager.getJson<ArticleDownloadPolicy>(
        key("article-policy", articleId),
      ));
    if (value)
      await this.setVersionedValue("article-policy", articleId, value, {
        updatedAt: current?.updatedAt ?? 0,
        synced: true,
      });
  },
  async saveArticleSegment(articleId: string, offset: number, data: unknown) {
    const policy = await this.getArticlePolicy(articleId);
    const storageKey = key("article-segments", articleId);
    const segments =
      (await resourceManager.getJson<Record<string, unknown>>(storageKey)) ??
      {};
    segments[String(offset)] = data;
    await resourceManager.putJson(
      storageKey,
      segments,
      policy.mode === "auto" ? "cache" : "persisted",
    );
  },
  async getArticleSegment<T>(articleId: string, offset: number) {
    const segments = await resourceManager.getJson<
      Record<
        string,
        T & { offset?: number; content?: string; content_length?: number }
      >
    >(key("article-segments", articleId));
    if (!segments) return null;
    if (segments[String(offset)]) return segments[String(offset)];
    for (const segment of Object.values(segments)) {
      if (
        typeof segment.offset !== "number" ||
        typeof segment.content !== "string"
      )
        continue;
      const relative = offset - segment.offset;
      if (relative >= 0 && relative < segment.content.length) {
        return {
          ...segment,
          offset,
          content: segment.content.slice(relative),
        } as T;
      }
    }
    return null;
  },

  async getDraft(ref: Pick<Conversation, "type" | "id">) {
    return resourceManager.getJson<DraftVersion>(
      key("draft", conversationId(ref)),
    );
  },
  async saveDraft(
    ref: Pick<Conversation, "type" | "id">,
    content: string,
    options?: { updatedAt?: number; synced?: boolean },
  ) {
    const current = await this.getDraft(ref);
    const updatedAt = options?.updatedAt ?? nextUpdatedAt(current);
    if (current && current.updatedAt > updatedAt) return current;
    const next: DraftVersion = {
      content,
      updatedAt,
      syncedAt: options?.synced ? updatedAt : null,
    };
    await resourceManager.putJson(
      key("draft", conversationId(ref)),
      next,
      "persisted",
    );
    return next;
  },
  async getPendingDraftRefs() {
    const prefix = key("draft");
    const refs: Array<{ type: "group" | "dm"; id: string }> = [];
    for (const storageKey of await resourceManager.keys(prefix)) {
      const draft = await resourceManager.getJson<DraftVersion>(storageKey);
      if (draft?.syncedAt !== null) continue;
      const suffix = storageKey.slice(prefix.length + 1);
      const separator = suffix.indexOf(":");
      const type = suffix.slice(0, separator);
      const id = suffix.slice(separator + 1);
      if ((type === "group" || type === "dm") && id) refs.push({ type, id });
    }
    return refs;
  },
};

export async function handleOfflineQuotaPressure(
  bytesToFree: number,
): Promise<number> {
  const candidates: Array<{
    priority: number;
    rank: number;
    evict: () => Promise<number>;
  }> = [];

  for (const { articleId } of await offlineRepository.getArticlePolicies()) {
    const policy = await offlineRepository.getArticlePolicy(articleId);
    if (policy.mode !== "retained") continue;
    candidates.push({
      priority: ARTICLE_RETENTION_DAYS.indexOf(policy.days) + 1,
      rank: policy.expiresAt - Date.now(),
      evict: async () => {
        const freed = await resourceManager.remove(
          key("article-segments", articleId),
        );
        await offlineRepository.setArticlePolicy(articleId, { mode: "auto" });
        return freed;
      },
    });
  }

  for (const {
    ref,
    policy,
  } of await offlineRepository.getConversationPolicies()) {
    if (policy === "auto") continue;
    const count = (await offlineRepository.getPosts(ref)).length;
    candidates.push({
      priority: policy === "week" ? 1 : 2,
      rank: -count,
      evict: async () => {
        const freed = await resourceManager.remove(
          key("posts", conversationId(ref)),
        );
        await offlineRepository.setConversationPolicy(ref, "auto");
        return freed;
      },
    });
  }

  candidates.sort((a, b) => a.priority - b.priority || a.rank - b.rank);
  let freed = 0;
  for (const candidate of candidates) {
    if (freed >= bytesToFree) break;
    freed += await candidate.evict();
  }
  return freed;
}

resourceManager.setQuotaPressureHandler(handleOfflineQuotaPressure);
