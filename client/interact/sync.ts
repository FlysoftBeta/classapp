import type { Conversation } from "@/shared/types/api";
import {
  fetchConversationDraft,
  fetchConversations,
  syncPendingConversationConfig,
} from "@/client/interact/conversations";
import { fetchPosts } from "@/client/interact/posts";
import {
  fetchArticle,
  fetchArticleSegment,
  primeOfflineArticleList,
  flushPendingArticleProgress,
  syncPendingArticleConfig,
} from "@/client/interact/articles";
import { downloadBundleForOffline } from "@/client/interact/bundles";
import { SEGMENT_SIZE } from "@/shared/types/api/article";
import {
  conversationRetentionCutoff,
  type ConversationDownloadPolicy,
} from "@/client/data/repository";
import { currentActorRepository as offlineRepository } from "@/client/interact/actorContext";
import { syncPendingUserSettings } from "@/client/interact/versionedSettings";
import { taskStore } from "@/client/hooks/useTaskStore";
import { captureDetachedClientIncident } from "@/client/interact/clientIncidents";
import { flushPendingClientLock } from "@/client/interact/clientLock";

async function retryLater<T>(
  label: string,
  operation: Promise<T>,
): Promise<T | null> {
  try {
    return await operation;
  } catch (error) {
    captureDetachedClientIncident(label, error);
    return null;
  }
}

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
    const convName = (await fetchConversations()).find(
      ({ id }) => id === ref.id,
    )?.name;
    if (convName)
      taskStore.getState().patch(taskId, { title: `对话 ${convName}` });
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
    if (article?.title)
      taskStore.getState().patch(taskId, { title: `文章 ${article.title}` });
    if (article?.content_kind === "bundle") {
      const size = await downloadBundleForOffline(articleId, (percent) => {
        taskStore.getState().patch(taskId, { progress: percent });
        onProgress?.(percent);
      });
      await offlineRepository.markArticlePolicySynced(articleId, size);
      taskStore.getState().patch(taskId, {
        status: "completed",
        progress: 100,
        detail: "文档已保存到本机",
      });
      return;
    }
    const contentLength = knownContentLength ?? article?.content_length;
    if (contentLength == null) {
      throw new Error("无法读取文章长度");
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
    if (offset < end) {
      throw new Error(`文章离线内容不完整 (${offset}/${end})`);
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
  await retryLater("sync.pending.client-lock", flushPendingClientLock());
  await Promise.all(
    [
      syncPendingUserSettings(),
      syncPendingConversationConfig(),
      syncPendingArticleConfig(),
    ].map((task, index) => retryLater(`sync.pending.${index}`, task)),
  );
  const drafts =
    (await retryLater(
      "sync.pending-drafts.read",
      offlineRepository.getPendingDraftRefs(),
    )) ?? [];
  await Promise.all(
    drafts.map((ref) =>
      retryLater("sync.pending-draft.flush", fetchConversationDraft(ref)),
    ),
  );
  const progress =
    (await retryLater(
      "sync.pending-article-progress.read",
      offlineRepository.getPendingArticleProgress(),
    )) ?? [];
  await Promise.all(
    progress.map((item) =>
      retryLater(
        "sync.pending-article-progress.flush",
        flushPendingArticleProgress(
          item.articleId,
          item.offset,
          item.updatedAt,
        ),
      ),
    ),
  );
}

export async function syncOfflineContent(): Promise<void> {
  await syncPendingMutations();
  await retryLater("sync.article-list-prime", primeOfflineArticleList());
  const conversationPolicies =
    (await retryLater(
      "sync.conversation-policies.read",
      offlineRepository.getConversationPolicies(),
    )) ?? [];
  for (const { ref, policy } of conversationPolicies) {
    try {
      await downloadConversationForOffline(ref, policy);
      await offlineRepository.markConversationPolicySynced(ref);
    } catch (error) {
      captureDetachedClientIncident("sync.conversation-policy", error);
      /* isolate this policy; retry on the next recovery */
    }
  }
  const articlePolicies =
    (await retryLater(
      "sync.article-policies.read",
      offlineRepository.getArticlePolicies(),
    )) ?? [];
  for (const { articleId, policy } of articlePolicies) {
    try {
      if (policy.mode !== "auto") await downloadArticleForOffline(articleId);
    } catch (error) {
      captureDetachedClientIncident("sync.article-policy", error);
      /* isolate this policy; retry on the next recovery */
    }
  }
}
