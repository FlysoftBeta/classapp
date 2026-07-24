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
import { offlineRepository } from "@/client/resource/offlineRepository";

export interface ArticleSegmentPayload {
  offset: number;
  content: string;
  content_length: number;
  has_more: boolean;
}

interface ArticleListPage {
  articles: ArticleWithMeta[];
  total: number;
}

const remoteArticlePageRequests = new Map<
  number,
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
  offset: number,
): Promise<ArticleListPage | null> {
  const existing = remoteArticlePageRequests.get(offset);
  if (existing) return existing;

  const request: Promise<ArticleListPage | null> = (async () => {
    const result = await listArticlesAction({ offset });
    observeActionResult(result);
    if (!result.ok) return null;
    return {
      articles: await reconcileArticleList(result.data.articles ?? []),
      total: result.data.total ?? 0,
    };
  })().finally(() => {
    if (remoteArticlePageRequests.get(offset) === request) {
      remoteArticlePageRequests.delete(offset);
    }
  });
  remoteArticlePageRequests.set(offset, request);
  return request;
}

export async function listArticles(offset: number) {
  if (!client.isConnected()) {
    const articles = await offlineRepository.getSavedArticleList();
    return {
      articles: articles.slice(offset, offset + 50),
      total: articles.length,
    };
  }
  const data = await fetchRemoteArticlePage(offset);
  if (data) {
    await offlineRepository.reconcileArticlePage(data.articles, {
      offset,
      total: data.total,
    });
  }
  return data;
}

export async function listBookmarkedArticles() {
  if (!client.isConnected()) {
    const articles = await offlineRepository.getSavedArticleList();
    return { articles: articles.filter((article) => article.is_bookmarked) };
  }
  const result = await listArticlesAction({ bookmarked: true });
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
  for (const offset of [0, 50, 100, 150]) {
    const page = await fetchRemoteArticlePage(offset);
    if (!page) break;
    const entries = page.articles;
    pages.push(...entries);
    if (entries.length < 50) break;
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

export async function fetchArticleSegment(articleId: string, offset: number) {
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
  await offlineRepository.saveArticleSegment(articleId, offset, data);
  return data;
}

export async function createArticle(body: { title: string; content: string }) {
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
  },
) {
  const form = new FormData();
  form.set("title", body.title);
  form.set("file", body.file);
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
  title?: string,
) {
  const result = await startNetworkArticleDownloadAction({
    book_id: bookId,
    ...(title ? { title } : {}),
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
