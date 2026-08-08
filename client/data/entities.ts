import type { ArticleWithMeta, Conversation, Post } from "@/shared/types/api";
import {
  openRuntimeDatabase,
  requestValue,
  transactionDone,
} from "@/client/resource/runtimeDatabase";
import {
  resourceManager,
  type ResourceClass,
} from "@/client/resource/resourceManager";
import { assertImmutableEntity } from "@/client/data/consistency";

interface StoredEntity<T> {
  userScope: string;
  value: T;
  touchedAt: number;
  size: number;
  resourceClass: ResourceClass;
}

interface StoredConversation extends StoredEntity<Conversation> {
  convId: string;
}
interface StoredPost extends StoredEntity<Post> {
  id: string;
  convId: string;
  sequence: number;
}
type ArticleState = Pick<
  ArticleWithMeta,
  | "is_bookmarked"
  | "bookmark_updated_at_ms"
  | "current_offset"
  | "current_offset_updated_at"
  | "current_locator"
  | "total_read_seconds"
  | "last_read_at"
>;
type ArticleEntity = Omit<ArticleWithMeta, keyof ArticleState>;
interface StoredArticle extends StoredEntity<ArticleEntity> {
  id: string;
}
interface StoredArticleState extends StoredEntity<ArticleState> {
  articleId: string;
}
interface StoredSegment<T = unknown> extends StoredEntity<T> {
  articleId: string;
  startOffset: number;
}

function estimateSize(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return 0;
  }
}

function splitArticle(value: ArticleWithMeta): {
  entity: ArticleEntity;
  state: ArticleState;
} {
  const {
    is_bookmarked,
    bookmark_updated_at_ms,
    current_offset,
    current_offset_updated_at,
    current_locator,
    total_read_seconds,
    last_read_at,
    ...entity
  } = value;
  return {
    entity,
    state: {
      is_bookmarked,
      bookmark_updated_at_ms,
      current_offset,
      current_offset_updated_at,
      current_locator,
      total_read_seconds,
      last_read_at,
    },
  };
}

function immutableArticleCore(entity: ArticleEntity) {
  return {
    id: entity.id,
    user_id: entity.user_id,
    group_id: entity.group_id,
    title: entity.title,
    provider: entity.provider,
    content_kind: entity.content_kind,
    blob_path: entity.blob_path,
    mime_type: entity.mime_type,
    file_size: entity.file_size,
    original_filename: entity.original_filename,
    created_at: entity.created_at,
    content_length: entity.content_length,
  };
}

async function recordsByIndex<T extends { touchedAt: number }>(
  storeName: string,
  indexName: string,
  key: IDBValidKey,
): Promise<T[]> {
  const db = await openRuntimeDatabase();
  const tx = db.transaction(storeName, "readwrite");
  const done = transactionDone(tx);
  const store = tx.objectStore(storeName);
  const result = (await requestValue(
    store.index(indexName).getAll(IDBKeyRange.only(key)),
  )) as T[];
  const touchedAt = Date.now();
  for (const row of result) store.put({ ...row, touchedAt });
  await done;
  return result;
}

async function noteWrite(resourceClass: ResourceClass): Promise<void> {
  await resourceManager.noteDomainWrite(resourceClass);
}

async function latestSegmentAtOrBefore<T>(
  userScope: string,
  articleId: string,
  offset: number,
): Promise<StoredSegment<T> | null> {
  const db = await openRuntimeDatabase();
  const tx = db.transaction("domain_article_segments", "readwrite");
  const done = transactionDone(tx);
  const index = tx
    .objectStore("domain_article_segments")
    .index("by-article-start");
  const range = IDBKeyRange.bound(
    [userScope, articleId, 0],
    [userScope, articleId, offset],
  );
  const cursor = await requestValue(index.openCursor(range, "prev"));
  const row = (cursor?.value as StoredSegment<T> | undefined) ?? null;
  if (cursor && row) cursor.update({ ...row, touchedAt: Date.now() });
  await done;
  return row;
}

export const entities = {
  async replaceConversations(
    userScope: string,
    entries: Conversation[],
  ): Promise<void> {
    const db = await openRuntimeDatabase();
    const tx = db.transaction("domain_conversations", "readwrite");
    const done = transactionDone(tx);
    const store = tx.objectStore("domain_conversations");
    const cursor = store
      .index("by-user")
      .openKeyCursor(IDBKeyRange.only(userScope));
    cursor.onsuccess = () => {
      if (!cursor.result) return;
      store.delete(cursor.result.primaryKey);
      cursor.result.continue();
    };
    const now = Date.now();
    for (const entry of entries) {
      store.put({
        userScope,
        convId: entry.conv_id,
        value: entry,
        touchedAt: now,
        size: estimateSize(entry),
        resourceClass: "persisted",
      } satisfies StoredConversation);
    }
    await done;
    await noteWrite("persisted");
  },

  async conversations(userScope: string): Promise<Conversation[]> {
    const rows = await recordsByIndex<StoredConversation>(
      "domain_conversations",
      "by-user",
      userScope,
    );
    return rows.map((row) => row.value);
  },

  async upsertConversation(
    userScope: string,
    entry: Conversation,
  ): Promise<void> {
    const db = await openRuntimeDatabase();
    const tx = db.transaction("domain_conversations", "readwrite");
    const done = transactionDone(tx);
    tx.objectStore("domain_conversations").put({
      userScope,
      convId: entry.conv_id,
      value: entry,
      touchedAt: Date.now(),
      size: estimateSize(entry),
      resourceClass: "persisted",
    } satisfies StoredConversation);
    await done;
    await noteWrite("persisted");
  },

  async removeConversation(userScope: string, convId: string): Promise<void> {
    const db = await openRuntimeDatabase();
    const tx = db.transaction(
      ["domain_conversations", "domain_posts"],
      "readwrite",
    );
    const done = transactionDone(tx);
    tx.objectStore("domain_conversations").delete([userScope, convId]);
    const posts = tx.objectStore("domain_posts");
    const cursor = posts
      .index("by-conversation")
      .openKeyCursor(IDBKeyRange.only([userScope, convId]));
    cursor.onsuccess = () => {
      if (!cursor.result) return;
      posts.delete(cursor.result.primaryKey);
      cursor.result.continue();
    };
    await done;
  },

  async posts(userScope: string, convId: string): Promise<Post[]> {
    const rows = await recordsByIndex<StoredPost>(
      "domain_posts",
      "by-conversation",
      [userScope, convId],
    );
    return rows
      .map((row) => row.value)
      .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  },

  async replacePosts(
    userScope: string,
    convId: string,
    posts: Post[],
    resourceClass: ResourceClass,
  ): Promise<void> {
    const db = await openRuntimeDatabase();
    const tx = db.transaction("domain_posts", "readwrite");
    const done = transactionDone(tx);
    const store = tx.objectStore("domain_posts");
    const cursor = store
      .index("by-conversation")
      .openKeyCursor(IDBKeyRange.only([userScope, convId]));
    cursor.onsuccess = () => {
      if (!cursor.result) return;
      store.delete(cursor.result.primaryKey);
      cursor.result.continue();
    };
    const now = Date.now();
    for (const post of posts) {
      store.put({
        userScope,
        id: post.id,
        convId,
        sequence: post.sequence ?? 0,
        value: post,
        touchedAt: now,
        size: estimateSize(post),
        resourceClass,
      } satisfies StoredPost);
    }
    await done;
    await noteWrite(resourceClass);
  },

  async removePosts(userScope: string, convId: string): Promise<number> {
    const rows = await recordsByIndex<StoredPost>(
      "domain_posts",
      "by-conversation",
      [userScope, convId],
    );
    const db = await openRuntimeDatabase();
    const tx = db.transaction("domain_posts", "readwrite");
    const done = transactionDone(tx);
    const store = tx.objectStore("domain_posts");
    for (const row of rows) store.delete([userScope, row.id]);
    await done;
    return rows.reduce((sum, row) => sum + row.size, 0);
  },

  async replaceArticles(
    userScope: string,
    entries: ArticleWithMeta[],
  ): Promise<void> {
    const db = await openRuntimeDatabase();
    const tx = db.transaction(
      ["domain_articles", "domain_article_state"],
      "readwrite",
    );
    const done = transactionDone(tx);
    const store = tx.objectStore("domain_articles");
    const stateStore = tx.objectStore("domain_article_state");
    const cursor = store
      .index("by-user")
      .openKeyCursor(IDBKeyRange.only(userScope));
    cursor.onsuccess = () => {
      if (!cursor.result) return;
      store.delete(cursor.result.primaryKey);
      cursor.result.continue();
    };
    const stateCursor = stateStore
      .index("by-user")
      .openKeyCursor(IDBKeyRange.only(userScope));
    stateCursor.onsuccess = () => {
      if (!stateCursor.result) return;
      stateStore.delete(stateCursor.result.primaryKey);
      stateCursor.result.continue();
    };
    const now = Date.now();
    for (const entry of entries) {
      const { entity, state } = splitArticle(entry);
      store.put({
        userScope,
        id: entry.id,
        value: entity,
        touchedAt: now,
        size: estimateSize(entity),
        resourceClass: "persisted",
      } satisfies StoredArticle);
      stateStore.put({
        userScope,
        articleId: entry.id,
        value: state,
        touchedAt: now,
        size: estimateSize(state),
        resourceClass: "persisted",
      } satisfies StoredArticleState);
    }
    await done;
    await noteWrite("persisted");
  },

  async articles(userScope: string): Promise<ArticleWithMeta[]> {
    const rows = await recordsByIndex<StoredArticle>(
      "domain_articles",
      "by-user",
      userScope,
    );
    const states = await recordsByIndex<StoredArticleState>(
      "domain_article_state",
      "by-user",
      userScope,
    );
    const byId = new Map(states.map((row) => [row.articleId, row.value]));
    return rows.map(
      (row) => ({ ...row.value, ...byId.get(row.id) }) as ArticleWithMeta,
    );
  },

  async upsertArticle(
    userScope: string,
    entry: ArticleWithMeta,
  ): Promise<void> {
    const db = await openRuntimeDatabase();
    const tx = db.transaction(
      ["domain_articles", "domain_article_state"],
      "readwrite",
    );
    const done = transactionDone(tx);
    const { entity, state } = splitArticle(entry);
    const now = Date.now();
    const articleStore = tx.objectStore("domain_articles");
    const previous = (await requestValue(
      articleStore.get([userScope, entry.id]),
    )) as StoredArticle | undefined;
    assertImmutableEntity(
      previous ? immutableArticleCore(previous.value) : null,
      immutableArticleCore(entity),
      `article:${entry.id}`,
    );
    articleStore.put({
      userScope,
      id: entry.id,
      value: entity,
      touchedAt: now,
      size: estimateSize(entity),
      resourceClass: "persisted",
    } satisfies StoredArticle);
    tx.objectStore("domain_article_state").put({
      userScope,
      articleId: entry.id,
      value: state,
      touchedAt: now,
      size: estimateSize(state),
      resourceClass: "persisted",
    } satisfies StoredArticleState);
    await done;
    await noteWrite("persisted");
  },

  async removeArticle(userScope: string, articleId: string): Promise<number> {
    const db = await openRuntimeDatabase();
    const tx = db.transaction(
      ["domain_articles", "domain_article_state", "domain_article_segments"],
      "readwrite",
    );
    const done = transactionDone(tx);
    tx.objectStore("domain_articles").delete([userScope, articleId]);
    tx.objectStore("domain_article_state").delete([userScope, articleId]);
    const segments = tx.objectStore("domain_article_segments");
    let freed = 0;
    const cursor = segments
      .index("by-article")
      .openCursor(IDBKeyRange.only([userScope, articleId]));
    cursor.onsuccess = () => {
      if (!cursor.result) return;
      freed += (cursor.result.value as StoredSegment).size;
      cursor.result.delete();
      cursor.result.continue();
    };
    await done;
    return freed;
  },

  async putSegment<T>(
    userScope: string,
    articleId: string,
    startOffset: number,
    value: T,
    resourceClass: ResourceClass,
  ): Promise<void> {
    const db = await openRuntimeDatabase();
    const tx = db.transaction("domain_article_segments", "readwrite");
    const done = transactionDone(tx);
    const store = tx.objectStore("domain_article_segments");
    const previous = (await requestValue(
      store.get([userScope, articleId, startOffset]),
    )) as StoredSegment<T> | undefined;
    assertImmutableEntity(
      previous?.value ?? null,
      value,
      `article-segment:${articleId}:${startOffset}`,
    );
    store.put({
      userScope,
      articleId,
      startOffset,
      value,
      touchedAt: Date.now(),
      size: estimateSize(value),
      resourceClass,
    } satisfies StoredSegment<T>);
    await done;
    await noteWrite(resourceClass);
  },

  async segment<T>(
    userScope: string,
    articleId: string,
    offset: number,
  ): Promise<T | null> {
    return (
      (await latestSegmentAtOrBefore<T>(userScope, articleId, offset))?.value ??
      null
    );
  },

  async removeSegments(userScope: string, articleId: string): Promise<number> {
    return this.removeArticleSegmentsOnly(userScope, articleId);
  },

  async removeArticleSegmentsOnly(
    userScope: string,
    articleId: string,
  ): Promise<number> {
    const db = await openRuntimeDatabase();
    const tx = db.transaction("domain_article_segments", "readwrite");
    const done = transactionDone(tx);
    const store = tx.objectStore("domain_article_segments");
    let freed = 0;
    const cursor = store
      .index("by-article")
      .openCursor(IDBKeyRange.only([userScope, articleId]));
    cursor.onsuccess = () => {
      if (!cursor.result) return;
      freed += (cursor.result.value as StoredSegment).size;
      cursor.result.delete();
      cursor.result.continue();
    };
    await done;
    return freed;
  },

  async evictCacheRows(bytesToFree: number): Promise<number> {
    if (bytesToFree <= 0) return 0;
    const db = await openRuntimeDatabase();
    const stores = ["domain_posts", "domain_article_segments"] as const;
    const tx = db.transaction([...stores], "readwrite");
    const done = transactionDone(tx);
    const groups = new Map<
      string,
      {
        store: (typeof stores)[number];
        keys: IDBValidKey[];
        size: number;
        touchedAt: number;
      }
    >();
    for (const storeName of stores) {
      const store = tx.objectStore(storeName);
      const rows = (await requestValue(store.getAll())) as Array<
        StoredPost | StoredSegment
      >;
      for (const row of rows) {
        if (row.resourceClass !== "cache") continue;
        const domainId =
          storeName === "domain_posts"
            ? (row as StoredPost).convId
            : (row as StoredSegment).articleId;
        const groupKey = `${storeName}:${row.userScope}:${domainId}`;
        const key =
          storeName === "domain_posts"
            ? [row.userScope, (row as StoredPost).id]
            : [
                row.userScope,
                (row as StoredSegment).articleId,
                (row as StoredSegment).startOffset,
              ];
        const group = groups.get(groupKey);
        if (group) {
          group.keys.push(key);
          group.size += row.size;
          group.touchedAt = Math.max(group.touchedAt, row.touchedAt);
        } else {
          groups.set(groupKey, {
            store: storeName,
            keys: [key],
            size: row.size,
            touchedAt: row.touchedAt,
          });
        }
      }
    }
    const candidates = [...groups.values()];
    candidates.sort((a, b) => a.touchedAt - b.touchedAt);
    let freed = 0;
    for (const candidate of candidates) {
      if (freed >= bytesToFree) break;
      const store = tx.objectStore(candidate.store);
      for (const key of candidate.keys) store.delete(key);
      freed += candidate.size;
    }
    await done;
    return freed;
  },
};
