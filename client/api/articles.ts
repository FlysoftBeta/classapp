import type { ArticleWithMeta } from "@/shared/types/api";
import {
  observeActionResult,
  apiFetch,
  authHeaders,
  parseJson,
} from "./runtime";
const {
  createArticleAction,
  deleteArticleAction,
  fetchArticleAction,
  fetchArticleSegmentAction,
  fetchArticleSidebarAction,
  listArticlesAction,
  reportArticleReadingAction,
  saveArticleProgressAction,
  setArticleBookmarkAction,
  searchNetworkArticlesAction,
  startNetworkArticleDownloadAction,
  listNetworkArticleDownloadsAction,
} = client.actions;
import { client } from "@/client/lib/remote/client";
import { ResultTools } from "@/shared/protocol/result";
import { offlineRepository } from "@/client/data/repository";

export interface ArticleSegmentPayload {
  offset: number;
  content: string;
  content_length: number;
  has_more: boolean;
}

interface ArticleListPage {
  articles: ArticleWithMeta[];
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

async function reconcileArticleProgressMeta(
  article: ArticleWithMeta,
): Promise<ArticleWithMeta> {
  const bookmark = await offlineRepository.reconcileVersionedValue(
    "article-config",
    `${article.id}:bookmarked`,
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
    ...article,
    is_bookmarked: bookmark.value,
    bookmark_updated_at_ms: bookmark.updatedAt,
    current_offset: progress.offset,
    current_offset_updated_at: progress.updatedAt,
  };
}

async function reconcileArticleList(
  articles: ArticleWithMeta[],
): Promise<ArticleWithMeta[]> {
  return Promise.all(articles.map(reconcileArticleProgressMeta));
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
    return {
      articles: await reconcileArticleList(result.data.articles ?? []),
      hasMore: result.data.hasMore,
    };
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
    const saved = await offlineRepository.getSavedArticleList();
    const articles = groupId
      ? saved.filter((article) => article.group_id === groupId)
      : saved;
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
  if (data) {
    if (groupId) {
      // A group-filtered page is only a partial view of the global cache. It
      // may add/update entries, but must never evict articles from other groups.
      await offlineRepository.mergeArticleListEntries(data.articles);
      for (const article of data.articles)
        await offlineRepository.saveArticleMeta(article);
    } else {
      await offlineRepository.reconcileArticlePage(data.articles, {
        offset: 0,
        total: data.articles.length,
      });
    }
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
    const articles = await offlineRepository.getSavedArticleList();
    return { articles: articles.filter((article) => article.is_bookmarked) };
  }
  const result = await listArticlesAction({ view: "bookmarked" });
  observeActionResult(result);
  if (!result.ok) return null;
  const data = result.data;
  if (data.articles) data.articles = await reconcileArticleList(data.articles);
  return data;
}

export async function fetchArticleSidebar() {
  if (!client.isConnected()) {
    const articles = await offlineRepository.getSavedArticleList();
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
  data.articles = await reconcileArticleList(data.articles);
  await offlineRepository.mergeArticleListEntries(data.articles);
  for (const article of data.articles)
    await offlineRepository.saveArticleMeta(article);
  return data;
}

export async function primeOfflineArticleList(): Promise<void> {
  if (!client.isConnected()) return;
  const pages: ArticleWithMeta[] = [];
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
  await offlineRepository.saveArticleList(pages.slice(0, 200));
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
  observeActionResult(result);
  if (!result.ok) return null;
  const data = result.data;
  if (data.article) {
    data.article = await reconcileArticleProgressMeta(data.article);
    await offlineRepository.saveArticleMeta(data.article);
    const progress = await offlineRepository.getArticleProgress(articleId);
    if (progress && !progress.synced) {
      data.article = { ...data.article, current_offset: progress.offset };
      void saveArticleProgress(articleId, progress.offset);
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

export async function fetchArticleSegment(
  articleId: string,
  offset: number,
  options: { requireCache?: boolean } = {},
) {
  const cached =
    await offlineRepository.getArticleSegment<ArticleSegmentPayload>(
      articleId,
      offset,
    );
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
    console.warn("[articles] Failed to cache text segment", {
      articleId,
      offset,
      error,
    });
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
  const data = result.ok ? result.data : { error: result.error.message };
  return { res, data };
}

export async function createBlobArticle(
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
    error?: string;
  }>(res);
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

async function updateCachedArticleBookmark(
  articleId: string,
  value: boolean,
  updatedAt: number,
) {
  const listEntry = (await offlineRepository.getArticleList()).find(
    (article) => article.id === articleId,
  );
  const meta = await offlineRepository.getArticleMeta(articleId);
  const source = meta ?? listEntry;
  if (!source) return;
  const updated = {
    ...source,
    is_bookmarked: value,
    bookmark_updated_at_ms: updatedAt,
  };
  await offlineRepository.saveArticleMeta(updated);
  if (listEntry) await offlineRepository.upsertArticleListEntry(updated);
}

export async function toggleArticleBookmark(
  articleId: string,
  bookmarked: boolean,
) {
  const id = `${articleId}:bookmarked`;
  const local = await offlineRepository.setVersionedValue(
    "article-config",
    id,
    bookmarked,
  );
  await updateCachedArticleBookmark(articleId, local.value, local.updatedAt);
  if (!client.isConnected()) return { bookmarked: local.value };
  try {
    const result = await setArticleBookmarkAction({
      articleId,
      bookmarked: local.value,
      updatedAt: local.updatedAt,
    });
    observeActionResult(result);
    if (!result.ok) return null;
    const winner = await offlineRepository.reconcileVersionedValue(
      "article-config",
      id,
      result.data,
    );
    await updateCachedArticleBookmark(
      articleId,
      winner.value,
      winner.updatedAt,
    );
    return { bookmarked: winner.value };
  } catch {
    return { bookmarked: local.value };
  }
}

export async function syncPendingArticleConfig() {
  if (!client.isConnected()) return;
  for (const {
    id,
    version,
  } of await offlineRepository.getPendingVersionedValues<boolean>(
    "article-config",
  )) {
    const separator = id.lastIndexOf(":");
    const articleId = id.slice(0, separator);
    const field = id.slice(separator + 1);
    if (!articleId || field !== "bookmarked") continue;
    try {
      const result = await setArticleBookmarkAction({
        articleId,
        bookmarked: version.value,
        updatedAt: version.updatedAt,
      });
      observeActionResult(result);
      if (!result.ok) continue;
      const winner = await offlineRepository.reconcileVersionedValue(
        "article-config",
        id,
        result.data,
      );
      await updateCachedArticleBookmark(
        articleId,
        winner.value,
        winner.updatedAt,
      );
    } catch {
      /* retry on the next recovery */
    }
  }
}

export async function saveArticleProgress(articleId: string, offset: number) {
  const local = await offlineRepository.setPendingArticleProgress(
    articleId,
    offset,
  );
  const localResult = () => ResultTools.ok(local, { buildId: client.buildId });
  if (!client.isConnected()) return localResult();
  try {
    const result = await saveArticleProgressAction({
      articleId,
      offset: local.offset,
      updatedAt: local.updatedAt,
    });
    const response = observeActionResult(result);
    if (result.ok) {
      await offlineRepository.reconcileArticleProgress(articleId, result.data);
    }
    return response;
  } catch {
    return localResult();
  }
}

export async function fetchArticleRender(
  token: string,
  articleId: string,
  params: {
    page: number;
    width: number;
    height: number;
  },
) {
  const query = new URLSearchParams({
    page: String(params.page),
    width: String(params.width),
    height: String(params.height),
  });
  return apiFetch(`/api/articles/${articleId}/render?${query.toString()}`, {
    headers: authHeaders(token),
  });
}

export async function deleteArticle(articleId: string) {
  const result = await deleteArticleAction(articleId);
  const res = observeActionResult(result);
  const data = result.ok ? result.data : { error: result.error.message };
  return { res, data };
}
