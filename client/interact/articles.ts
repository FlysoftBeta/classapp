import { client } from "@/client/interact/remote/client";
import type { ArticleWithMeta, UserMetadata } from "@/shared/types/api";
import type { Article } from "@/client/interact/presentation";
import {
  observeActionResult,
  apiFetch,
  authHeaders,
  parseJson,
} from "@/client/api/runtime";
import { ResultTools } from "@/shared/protocol/result";
import { currentActorRepository as offlineRepository } from "@/client/interact/actorContext";
import { purgeArticleBundle } from "@/client/interact/bundles";
import { captureDetachedClientIncident } from "@/client/interact/clientIncidents";
import {
  cacheUserMetadata,
  userMetadataById,
} from "@/client/interact/users";
import {
  rememberArticleCapabilities,
  rememberArticleCapability,
  articleCapability,
} from "./capabilities";
import type { AccessGrant, PrincipalRef } from "@/shared/access";
import type { BooklistSnapshot, BooklistSummary } from "@/shared/types/api";

const {
  createArticleAction,
  deleteArticleAction,
  fetchArticleAction,
  fetchArticleSegmentAction,
  fetchArticleSidebarAction,
  listArticlesAction,
  articlesLibraryAction,
  booklistFetchAction,
  booklistForGroupAction,
  booklistCreateAction,
  booklistDeleteAction,
  booklistAddArticleAction,
  booklistRemoveArticleAction,
  booklistGrantAccessAction,
  booklistRevokeAccessAction,
  booklistListBindingsAction,
  reportArticleReadingAction,
  saveArticleProgressAction,
  setArticleBookmarkAction,
  searchNetworkArticlesAction,
  startNetworkArticleDownloadAction,
  listNetworkArticleDownloadsAction,
} = client.actions;

export interface ArticleSegmentPayload {
  offset: number;
  content: string;
  content_length: number;
  has_more: boolean;
}

interface ArticleListPage {
  articles: Article[];
  hasMore: boolean;
}

export interface ArticleListCursor {
  sortAt: string;
  id: string;
}

const remoteArticlePageRequests = new Map<
  string,
  Promise<ArticleListPage | null>
>();

function materializeArticle(
  article: ArticleWithMeta,
  users: readonly UserMetadata[],
): Article {
  const author = article.user_id
    ? userMetadataById(users).get(article.user_id)
    : undefined;
  return {
    ...article,
    username: author?.username ?? null,
    handle: author?.handle ?? null,
  };
}

async function reconcileArticleProgressMeta(
  article: ArticleWithMeta,
  users: readonly UserMetadata[],
  membership: {
    view: "all" | "bookmarked" | "sidebar" | "direct";
    group_id: string | null;
  } = { view: "direct", group_id: null },
  cacheUsers = true,
): Promise<Article> {
  try {
    if (cacheUsers) await cacheUserMetadata(users);
    await offlineRepository.saveArticleMeta(article, membership);
    const bookmark = await offlineRepository.reconcileArticleBookmark(
      article.id,
      {
        value: article.is_bookmarked,
        updatedAt: article.bookmark_updated_at_ms,
      },
    );
    const progress = await offlineRepository.reconcileArticleProgress(
      article.id,
      {
        offset: article.current_offset,
        updatedAt: article.current_offset_updated_at,
      },
    );
    return {
      ...materializeArticle(article, users),
      is_bookmarked: bookmark.value,
      bookmark_updated_at_ms: bookmark.updatedAt,
      current_offset: progress.offset,
      current_offset_updated_at: progress.updatedAt,
    };
  } catch (error) {
    // IDB is an evictable projection. A cache panic is reported, but cannot
    // invalidate a server payload that already passed the Action contract.
    captureDetachedClientIncident("article.meta-cache", error);
    return article;
  }
}

async function reconcileArticleList(
  articles: ArticleWithMeta[],
  users: readonly UserMetadata[],
  membership: {
    view: "all" | "bookmarked" | "sidebar";
    group_id: string | null;
  },
): Promise<Article[]> {
  try {
    await cacheUserMetadata(users);
  } catch (error) {
    captureDetachedClientIncident("article.user-cache", error);
  }
  return Promise.all(
    articles.map((article) =>
      reconcileArticleProgressMeta(article, users, membership, false),
    ),
  );
}

async function fetchRemoteArticlePage(
  cursor?: ArticleListCursor,
  direction: "before" | "after" = "after",
  groupId?: string,
): Promise<ArticleListPage | null> {
  const key = `${groupId ?? "all"}:${direction}:${cursor?.sortAt ?? "start"}:${cursor?.id ?? "start"}`;
  const existing = remoteArticlePageRequests.get(key);
  if (existing) return existing;

  const request: Promise<ArticleListPage | null> = (async () => {
    const result = await listArticlesAction({
      view: "all",
      direction,
      ...(cursor ? { cursor } : {}),
      ...(groupId ? { group_id: groupId } : {}),
    });
    observeActionResult(result);
    if (!result.ok) return null;
    const articles = await reconcileArticleList(
      result.data.articles ?? [],
      result.data.users,
      { view: "all", group_id: groupId ?? null },
    );
    rememberArticleCapabilities(result.data.articles ?? []);
    try {
      await offlineRepository.reconcileArticlePage(articles, {
        view: "all",
        groupId: groupId ?? null,
        direction,
        cursor: cursor ?? null,
        hasMore: result.data.hasMore,
      });
    } catch (error) {
      captureDetachedClientIncident("article.coverage-cache", error);
    }
    return { articles, hasMore: result.data.hasMore };
  })().finally(() => {
    if (remoteArticlePageRequests.get(key) === request) {
      remoteArticlePageRequests.delete(key);
    }
  });
  remoteArticlePageRequests.set(key, request);
  return request;
}

export async function listArticles(
  cursor?: ArticleListCursor | number,
  directionOrGroup?: "before" | "after" | string,
  explicitGroupId?: string,
): Promise<(ArticleListPage & { total: number }) | null> {
  const direction =
    directionOrGroup === "before" || directionOrGroup === "after"
      ? directionOrGroup
      : "after";
  const groupId =
    directionOrGroup === "before" || directionOrGroup === "after"
      ? explicitGroupId
      : directionOrGroup;
  if (!client.isConnected()) {
    const cached = await offlineRepository.getArticleList();
    const articles = groupId
      ? cached.filter((article) => article.group_id === groupId)
      : cached;
    return {
      articles: articles.slice(0, 50),
      hasMore: articles.length > 50,
      total: articles.length,
    };
  }
  // Infini's locateOffset is an estimate, not a server pagination contract.
  // Translate it into cursor walks so the transport never falls back to OFFSET.
  let skipped = typeof cursor === "number" ? Math.max(0, cursor) : 0;
  let pageCursor = typeof cursor === "number" ? undefined : cursor;
  let data: ArticleListPage | null = null;
  while (true) {
    data = await fetchRemoteArticlePage(pageCursor, direction, groupId);
    if (!data || skipped < data.articles.length || !data.hasMore) break;
    skipped -= data.articles.length;
    const last =
      direction === "after" ? data.articles.at(-1) : data.articles[0];
    if (!last?.list_sort_at) break;
    pageCursor = { sortAt: last.list_sort_at, id: last.id };
  }
  if (data && skipped > 0) {
    data = {
      ...data,
      articles: data.articles.slice(skipped),
    };
  }
  return data
    ? {
        ...data,
        // The virtualizer only uses this as a local exhaustion estimate. Exact
        // totals would require the COUNT scan cursor pagination removes.
        total:
          (typeof cursor === "number" ? cursor : 0) +
          data.articles.length +
          (data.hasMore ? 1 : 0),
      }
    : null;
}

export async function listBookmarkedArticles() {
  if (!client.isConnected()) {
    const articles = await offlineRepository.getArticleList();
    return { articles: articles.filter((article) => article.is_bookmarked) };
  }
  const result = await listArticlesAction({ view: "bookmarked" });
  observeActionResult(result);
  if (!result.ok) return null;
  const data = result.data;
  if (data.articles) {
    data.articles = await reconcileArticleList(data.articles, data.users, {
      view: "bookmarked",
      group_id: null,
    });
  }
  return data;
}

export async function fetchArticleSidebar() {
  if (!client.isConnected()) {
    const articles = await offlineRepository.getArticleList();
    return {
      current_article_id: null,
      articles: articles.filter(
        (article) => article.current_offset > 0 || article.is_bookmarked,
      ),
    };
  }
  const result = await fetchArticleSidebarAction();
  observeActionResult(result);
  if (!result.ok) return null;
  const data = result.data;
  data.articles = await reconcileArticleList(data.articles, data.users, {
    view: "sidebar",
    group_id: null,
  });
  return data;
}

export async function primeOfflineArticleList(): Promise<void> {
  if (!client.isConnected()) return;
  const pages: Article[] = [];
  let cursor: ArticleListCursor | undefined;
  for (let pageNumber = 0; pageNumber < 4; pageNumber++) {
    const page = await fetchRemoteArticlePage(cursor);
    if (!page) break;
    const entries = page.articles;
    pages.push(...entries);
    const last = entries.at(-1);
    if (!page.hasMore || !last?.list_sort_at) break;
    cursor = { sortAt: last.list_sort_at, id: last.id };
  }
  await offlineRepository.saveArticleList(pages.slice(0, 200), {
    view: "all",
    group_id: null,
  });
}

export async function reportArticleReading(
  articleId: string,
  body: { seconds: number; active: boolean },
) {
  return observeActionResult(
    await reportArticleReadingAction({
      articleId,
      seconds: body.seconds,
      active: body.active,
    }),
  );
}

export async function fetchArticle(articleId: string) {
  if (!client.isConnected()) {
    const article =
      (await offlineRepository.getArticleMeta(articleId)) ??
      (await offlineRepository.getArticleList()).find(
        (item) => item.id === articleId,
      ) ??
      null;
    const progress = await offlineRepository.getArticleProgress(articleId);
    return article
      ? {
          article: progress
            ? { ...article, current_offset: progress.offset }
            : article,
        }
      : null;
  }
  const result = await fetchArticleAction(articleId);
  if (result.ok) rememberArticleCapability(articleId, result.data.article.capability);
  observeActionResult(result);
  if (!result.ok) return null;
  const data = result.data;
  if (data.article) {
    data.article = await reconcileArticleProgressMeta(data.article, data.users);
    try {
      const progress = await offlineRepository.getArticleProgress(articleId);
      if (progress && !progress.synced) {
        data.article = { ...data.article, current_offset: progress.offset };
      }
    } catch (error) {
      captureDetachedClientIncident("article.progress-cache", error);
    }
  }
  return data;
}

export async function fetchCachedArticle(articleId: string) {
  const article =
    (await offlineRepository.getArticleMeta(articleId)) ??
    (await offlineRepository.getArticleList()).find(
      (item) => item.id === articleId,
    ) ??
    null;
  if (!article) return null;
  const progress = await offlineRepository.getArticleProgress(articleId);
  return {
    article: progress
      ? { ...article, current_offset: progress.offset }
      : article,
  };
}

export async function loadArticleForReader(
  articleId: string,
  onCached?: (article: Article) => void | Promise<void>,
): Promise<{
  source: "remote" | "offline";
  article: Article | null;
}> {
  let cached: Awaited<ReturnType<typeof fetchCachedArticle>> = null;
  try {
    cached = await fetchCachedArticle(articleId);
  } catch (error) {
    captureDetachedClientIncident("article.reader-cache", error);
    if (!client.isConnected()) throw error;
  }
  if (cached?.article) await onCached?.(cached.article);
  if (!client.isConnected()) {
    return { source: "offline", article: cached?.article ?? null };
  }
  const remote = await fetchArticle(articleId);
  return { source: "remote", article: remote?.article ?? null };
}

export async function fetchArticleSegment(
  articleId: string,
  offset: number,
  options: { requireCache?: boolean } = {},
) {
  let cached: ArticleSegmentPayload | null = null;
  try {
    cached = await offlineRepository.getArticleSegment<ArticleSegmentPayload>(
      articleId,
      offset,
    );
  } catch (error) {
    captureDetachedClientIncident("article.segment-cache-read", error);
    if (!client.isConnected()) throw error;
  }
  // Article bodies are immutable. A cached segment is authoritative and can
  // warm-start the reader even while the remote connection is available.
  if (cached || !client.isConnected()) return cached;
  const result = await fetchArticleSegmentAction({ articleId, offset });
  observeActionResult(result);
  if (!result.ok) return null;
  const data = result.data;
  try {
    await offlineRepository.saveArticleSegment(articleId, offset, data);
  } catch (error) {
    // The remote payload is still usable when an evictable IndexedDB cache
    // write fails under storage pressure. Do not turn a successful reader
    // fetch into an Infini provider failure solely because its cache could not
    // be warmed.
    if (options.requireCache) throw error;
    captureDetachedClientIncident("article.segment-cache-write", error);
  }
  return data;
}

export async function createArticle(body: {
  title: string;
  content: string;
  group_id: string;
}) {
  const result = await createArticleAction(body);
  const res = observeActionResult(result);
  if (result.ok) {
    rememberArticleCapability(result.data.article.id, result.data.capability);
    await cacheUserMetadata(result.data.users);
    result.data.article = materializeArticle(
      { ...result.data.article, capability: result.data.capability },
      result.data.users,
    );
  }
  const data = result.ok ? result.data : { error: result.error.message };
  return { res, data };
}

export async function createBundleArticle(
  token: string,
  body: {
    title: string;
    file: File;
    group_id: string;
  },
) {
  const form = new FormData();
  form.set("title", body.title);
  form.set("file", body.file);
  form.set("group_id", body.group_id);
  const res = await apiFetch("/api/articles", {
    method: "POST",
    headers: authHeaders(token),
    body: form,
  });
  const data = await parseJson<{
    article?: ArticleWithMeta;
    users?: UserMetadata[];
    error?: string;
  }>(res);
  if (data.article && data.users) {
    await cacheUserMetadata(data.users);
    data.article = materializeArticle(data.article, data.users);
  }
  return { res, data };
}

export async function searchNetworkArticles(query: string) {
  const result = await searchNetworkArticlesAction({ query });
  observeActionResult(result);
  return result.ok ? result.data : null;
}

export async function startNetworkArticleDownload(
  bookId: string,
  groupId: string,
  title?: string,
) {
  const result = await startNetworkArticleDownloadAction({
    book_id: bookId,
    ...(title ? { title } : {}),
    group_id: groupId,
  });
  observeActionResult(result);
  return result.ok ? result.data.task : null;
}

export async function listNetworkArticleDownloads() {
  const result = await listNetworkArticleDownloadsAction();
  observeActionResult(result);
  return result.ok ? result.data.tasks : [];
}

export async function toggleArticleBookmark(
  articleId: string,
  bookmarked: boolean,
) {
  const local = await offlineRepository.setArticleBookmark(
    articleId,
    bookmarked,
  );
  if (!client.isConnected()) return { bookmarked: local.value };
  const result = await setArticleBookmarkAction({
    articleId,
    bookmarked: local.value,
    updatedAt: local.updatedAt,
    capability: articleCapability(articleId),
  });
  observeActionResult(result);
  if (!result.ok) return null;
  try {
    const winner = await offlineRepository.reconcileArticleBookmark(
      articleId,
      result.data,
    );
    return { bookmarked: winner.value };
  } catch (error) {
    captureDetachedClientIncident("article.bookmark-cache", error);
    return { bookmarked: local.value };
  }
}

export async function syncPendingArticleConfig() {
  if (!client.isConnected()) return;
  for (const pending of await offlineRepository.getPendingArticleBookmarks()) {
    const { articleId, value, updatedAt } = pending;
    try {
      const result = await setArticleBookmarkAction({
        articleId,
        bookmarked: value,
        updatedAt,
        capability: articleCapability(articleId),
      });
      observeActionResult(result);
      if (!result.ok) continue;
      await offlineRepository.reconcileArticleBookmark(articleId, result.data);
    } catch (error) {
      captureDetachedClientIncident("article.bookmark.flush", error);
      /* retry on the next recovery */
    }
  }
}

export async function saveArticleProgress(articleId: string, offset: number) {
  const offline = !client.isConnected();
  const local = await offlineRepository.setPendingArticleProgress(
    articleId,
    offset,
    offline,
  );
  const localResult = () => ResultTools.ok(local, { buildId: client.buildId });
  if (!client.isConnected()) return localResult();
  const result = await saveArticleProgressAction({
    articleId,
    offset: local.offset,
    updatedAt: local.updatedAt,
    merge: "override",
  });
  const response = observeActionResult(result);
  if (result.ok) {
    try {
      await offlineRepository.reconcileArticleProgress(
        articleId,
        result.data,
        "override",
      );
    } catch (error) {
      captureDetachedClientIncident("article.progress-cache", error);
    }
  }
  return response;
}

export async function flushPendingArticleProgress(
  articleId: string,
  offset: number,
  updatedAt: number,
): Promise<void> {
  if (!client.isConnected()) return;
  const result = await saveArticleProgressAction({
    articleId,
    offset,
    updatedAt,
    merge: "furthest",
  });
  observeActionResult(result);
  if (result.ok) {
    await offlineRepository.reconcileArticleProgress(
      articleId,
      result.data,
      "furthest",
    );
  }
}

export function fetchArticleSource(token: string, articleId: string) {
  const capability = articleCapability(articleId);
  const query = capability
    ? `?capability=${encodeURIComponent(capability)}`
    : "";
  return apiFetch(`/api/articles/${articleId}/source${query}`, {
    headers: authHeaders(token),
  });
}

export async function deleteArticle(articleId: string) {
  const result = await deleteArticleAction(articleId);
  const res = observeActionResult(result);
  const data = result.ok ? result.data : { error: result.error.message };
  if (result.ok) {
    await purgeArticleBundle(articleId);
    await offlineRepository.purgeArticle(articleId);
  }
  return { res, data };
}

export async function fetchArticlesLibrary(): Promise<{
  recents: Article[];
  favorites: Article[];
  booklists: BooklistSummary[];
} | null> {
  const result = await articlesLibraryAction();
  observeActionResult(result);
  if (!result.ok) return null;
  rememberArticleCapabilities(result.data.recents);
  rememberArticleCapabilities(result.data.favorites);
  const recents = await reconcileArticleList(
    result.data.recents,
    result.data.users,
    { view: "sidebar", group_id: null },
  );
  const favorites = await reconcileArticleList(
    result.data.favorites,
    result.data.users,
    { view: "bookmarked", group_id: null },
  );
  return { recents, favorites, booklists: result.data.booklists };
}

export async function fetchBooklist(
  booklistId: string,
): Promise<BooklistSnapshot | null> {
  const result = await booklistFetchAction(booklistId);
  observeActionResult(result);
  if (!result.ok) return null;
  rememberArticleCapabilities(result.data.articles);
  await reconcileArticleList(result.data.articles, result.data.users, {
    view: "all",
    group_id: result.data.list.origin_group_id,
  });
  return result.data;
}

export async function fetchGroupBooklist(
  groupId: string,
): Promise<BooklistSnapshot | null> {
  const result = await booklistForGroupAction({ groupId });
  observeActionResult(result);
  if (!result.ok || !result.data) return null;
  rememberArticleCapabilities(result.data.articles);
  await reconcileArticleList(result.data.articles, result.data.users, {
    view: "all",
    group_id: groupId,
  });
  return result.data;
}

export async function createBooklist(title: string) {
  const result = await booklistCreateAction({ title });
  observeActionResult(result);
  if (!result.ok) return null;
  return result.data;
}

export async function deleteBooklist(booklistId: string) {
  const result = await booklistDeleteAction(booklistId);
  observeActionResult(result);
  return result.ok;
}

export async function addArticleToBooklist(
  booklistId: string,
  articleId: string,
) {
  const result = await booklistAddArticleAction({
    booklistId,
    articleId,
    capability: articleCapability(articleId),
  });
  observeActionResult(result);
  if (!result.ok) return null;
  rememberArticleCapabilities(result.data.articles);
  return result.data;
}

export async function removeArticleFromBooklist(
  booklistId: string,
  articleId: string,
) {
  const result = await booklistRemoveArticleAction({ booklistId, articleId });
  observeActionResult(result);
  if (!result.ok) return null;
  rememberArticleCapabilities(result.data.articles);
  return result.data;
}

export async function grantBooklistAccess(
  booklistId: string,
  principal: PrincipalRef,
  grant: AccessGrant,
) {
  const result = await booklistGrantAccessAction({
    booklistId,
    principal,
    grant,
  });
  observeActionResult(result);
  if (!result.ok) return null;
  return result.data;
}

export async function revokeBooklistAccess(
  booklistId: string,
  principal: PrincipalRef,
) {
  const result = await booklistRevokeAccessAction({ booklistId, principal });
  observeActionResult(result);
  if (!result.ok) return null;
  return result.data;
}

export async function listBooklistBindings(booklistId: string) {
  const result = await booklistListBindingsAction({ booklistId });
  observeActionResult(result);
  if (!result.ok) return { bindings: [] };
  return result.data;
}
