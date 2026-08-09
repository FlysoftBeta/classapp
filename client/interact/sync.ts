import type { Conversation } from "@/shared/types/api";
import {
  fetchConversationDraft,
  syncPendingConversationConfig,
} from "@/client/interact/conversations";
import { fetchPosts } from "@/client/interact/posts";
import {
  fetchArticle,
  fetchArticleSegment,
  fetchArticleBlob,
  primeOfflineArticleList,
  flushPendingArticleProgress,
  syncPendingArticleConfig,
} from "@/client/interact/articles";
import { session } from "@/client/interact/remote/session";
import { extentFiles } from "@/client/data/files";
import { FileIds } from "@/client/data/fileIds";
import { recoverFromQuotaExceeded } from "@/client/interact/quota";
import { SEGMENT_SIZE } from "@/shared/types/api/article";
import {
  offlineRepository,
  conversationRetentionCutoff,
  type ConversationDownloadPolicy,
} from "@/client/data/repository";
import { syncPendingUserSettings } from "@/client/interact/versionedSettings";
import { taskStore } from "@/client/hooks/useTaskStore";

export async function downloadConversationForOffline(
  ref: Pick<Conversation, "type" | "id" | "conv_id">,
  policy: ConversationDownloadPolicy,
  onProgress?: (count: number) => void,
): Promise<void> {
  if (policy === "auto") return;
  const taskId = `conversation-offline:${ref.type}:${ref.id}`;
  const cutoff = conversationRetentionCutoff(policy)!;
  let beforeId = "";
  let count = 0;
  taskStore.getState().upsert({
    id: taskId,
    kind: "conversation-offline",
    title: `对话 ${ref.id}`,
    status: "running",
    progress: 0,
    total: 0,
    updatedAt: Date.now(),
  });
  try {
    while (true) {
      const limit = 200;
      const data = await fetchPosts(ref, {
        limit: String(limit),
        ...(beforeId ? { before_id: beforeId } : {}),
      });
      const page = data?.posts ?? [];
      count += page.filter((post) => {
        const createdAt = Date.parse(
          post.created_at.endsWith("Z")
            ? post.created_at
            : `${post.created_at}Z`,
        );
        return createdAt >= cutoff;
      }).length;
      taskStore.getState().patch(taskId, { progress: count });
      onProgress?.(count);
      if (page.length < limit) break;
      const oldest = page[page.length - 1];
      if (
        !oldest ||
        Date.parse(
          oldest.created_at.endsWith("Z")
            ? oldest.created_at
            : `${oldest.created_at}Z`,
        ) < cutoff
      )
        break;
      beforeId = page[page.length - 1]?.id ?? "";
      if (!beforeId) break;
    }
    taskStore
      .getState()
      .patch(taskId, { status: "completed", progress: count, total: count });
  } catch (error) {
    taskStore.getState().patch(taskId, {
      status: "failed",
      detail: error instanceof Error ? error.message : "离线保存失败",
    });
    throw error;
  }
}

export async function downloadArticleForOffline(
  articleId: string,
  onProgress?: (percent: number) => void,
  knownContentLength?: number,
): Promise<void> {
  const policy = await offlineRepository.getArticlePolicy(articleId);
  if (policy.mode === "auto") return;
  const taskId = `article-offline:${articleId}`;
  taskStore.getState().upsert({
    id: taskId,
    kind: "article-offline",
    title: `文章 ${articleId}`,
    status: "running",
    progress: 0,
    total: 100,
    updatedAt: Date.now(),
  });
  try {
    const result = await fetchArticle(articleId);
    const article = result?.article;
    if (article && article.content_kind !== "text") {
      const response = await fetchArticleBlob(session.getToken(), articleId);
      if (!response.ok || !response.body) {
        throw new Error(`文章文件下载失败 (${response.status})`);
      }
      const expectedSize = Number(response.headers.get("Content-Length"));
      const size = Number.isSafeInteger(expectedSize) && expectedSize >= 0
        ? expectedSize
        : article.file_size;
      let loaded = 0;
      const reader = response.body.getReader();
      const progress = new ReadableStream<Uint8Array>({
        pull: async (controller) => {
          const next = await reader.read();
          if (next.done) {
            controller.close();
            return;
          }
          loaded += next.value.byteLength;
          const percent = Math.min(100, Math.round((loaded / Math.max(1, size)) * 100));
          taskStore.getState().patch(taskId, { progress: percent });
          onProgress?.(percent);
          controller.enqueue(next.value);
        },
        cancel: (reason) => reader.cancel(reason),
      });
      await recoverFromQuotaExceeded(() =>
        extentFiles.replace(FileIds.articleBlob(articleId), size, progress),
      );
      await offlineRepository.markArticlePolicySynced(articleId, size);
      taskStore.getState().patch(taskId, {
        status: "completed",
        progress: 100,
        detail: "PDF 已保存到本机",
      });
      return;
    }
    const contentLength = knownContentLength ?? article?.content_length;
    if (contentLength == null) {
      taskStore
        .getState()
        .patch(taskId, { status: "failed", detail: "无法读取文章长度" });
      return;
    }
    const start = 0;
    const end = contentLength;
    let offset = Math.floor(start / SEGMENT_SIZE) * SEGMENT_SIZE;
    while (offset < end) {
      const cached = await offlineRepository.getArticleSegment<{
        offset: number;
        content: string;
        has_more: boolean;
      }>(articleId, offset);
      const data =
        cached ??
        (await fetchArticleSegment(articleId, offset, {
          requireCache: true,
        }));
      if (!data?.content) break;
      offset = data.offset + data.content.length;
      const percent = Math.min(
        100,
        Math.round(
          ((Math.min(offset, end) - start) / Math.max(1, end - start)) * 100,
        ),
      );
      taskStore.getState().patch(taskId, { progress: percent });
      onProgress?.(percent);
      if (!data.has_more) break;
    }
    await offlineRepository.markArticlePolicySynced(articleId);
    taskStore.getState().patch(taskId, { status: "completed", progress: 100 });
  } catch (error) {
    taskStore.getState().patch(taskId, {
      status: "failed",
      detail: error instanceof Error ? error.message : "离线保存失败",
    });
    throw error;
  }
}

export async function syncPendingMutations(): Promise<void> {
  await Promise.all(
    [
      syncPendingUserSettings(),
      syncPendingConversationConfig(),
      syncPendingArticleConfig(),
    ].map((task) => task.catch(() => undefined)),
  );
  const drafts = await offlineRepository.getPendingDraftRefs().catch(() => []);
  await Promise.all(
    drafts.map((ref) => fetchConversationDraft(ref).catch(() => undefined)),
  );
  const progress = await offlineRepository
    .getPendingArticleProgress()
    .catch(() => []);
  await Promise.all(
    progress.map((item) =>
      flushPendingArticleProgress(
        item.articleId,
        item.offset,
        item.updatedAt,
      ).catch(() => undefined),
    ),
  );
}

export async function syncOfflineContent(): Promise<void> {
  await syncPendingMutations();
  await primeOfflineArticleList().catch(() => {});
  const conversationPolicies = await offlineRepository
    .getConversationPolicies()
    .catch(() => []);
  for (const { ref, policy } of conversationPolicies) {
    try {
      await downloadConversationForOffline(ref, policy);
      await offlineRepository.markConversationPolicySynced(ref);
    } catch {
      /* isolate this policy; retry on the next recovery */
    }
  }
  const articlePolicies = await offlineRepository
    .getArticlePolicies()
    .catch(() => []);
  for (const { articleId, policy } of articlePolicies) {
    try {
      if (policy.mode !== "auto") await downloadArticleForOffline(articleId);
    } catch {
      /* isolate this policy; retry on the next recovery */
    }
  }
}
