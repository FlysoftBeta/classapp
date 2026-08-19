import type { ArticleWithMeta } from "@/shared/types/api";
import type { Conversation } from "@/client/interact/presentation";
import {
  ARTICLE_RETENTION_DAYS,
  type ArticleDownloadPolicy,
  type ConversationDownloadPolicy,
} from "@/client/data/retentionPolicy";
import { currentActorRepository as offlineRepository } from "@/client/interact/actorContext";
import { bundleAvailable } from "@/client/interact/bundles";
import { client } from "@/client/interact/remote/client";
import {
  downloadArticleForOffline,
  downloadConversationForOffline,
} from "@/client/interact/sync";

export {
  ARTICLE_RETENTION_DAYS,
  type ArticleDownloadPolicy,
  type ConversationDownloadPolicy,
};

export function getConversationRetention(
  conversation: Pick<Conversation, "type" | "id">,
) {
  return offlineRepository.getConversationPolicy(conversation);
}

export async function saveConversationRetention(
  conversation: Pick<Conversation, "type" | "id" | "conv_id">,
  policy: ConversationDownloadPolicy,
  onProgress?: (count: number) => void,
): Promise<ConversationDownloadPolicy> {
  await offlineRepository.setConversationPolicy(conversation, policy);
  if (client.isConnected() && policy !== "auto") {
    await downloadConversationForOffline(conversation, policy, onProgress);
    await offlineRepository.markConversationPolicySynced(conversation);
  }
  return offlineRepository.getConversationPolicy(conversation);
}

export function getArticleRetention(articleId: string) {
  return offlineRepository.getArticlePolicy(articleId);
}

export async function saveArticleRetention(
  article: Pick<ArticleWithMeta, "id" | "content_kind" | "content_length">,
  policy: ArticleDownloadPolicy,
  onProgress?: (percent: number) => void,
): Promise<ArticleDownloadPolicy> {
  await offlineRepository.setArticlePolicy(article.id, policy);
  if (client.isConnected() && policy.mode === "retained") {
    await downloadArticleForOffline(
      article.id,
      onProgress,
      article.content_kind === "text" ? article.content_length : undefined,
    );
  }
  return offlineRepository.getArticlePolicy(article.id);
}

export async function articleContentAvailable(
  article: Pick<ArticleWithMeta, "id" | "content_kind" | "current_offset">,
): Promise<boolean> {
  if (article.content_kind === "bundle") {
    return bundleAvailable(article.id, article.current_offset);
  }
  return !!(await offlineRepository.getArticleSegment(
    article.id,
    article.current_offset,
  ));
}

export async function canReadArticle(
  article: Pick<ArticleWithMeta, "id" | "content_kind" | "current_offset">,
): Promise<boolean> {
  return client.isConnected() || articleContentAvailable(article);
}

export function forgetArticle(articleId: string) {
  return offlineRepository.removeArticle(articleId);
}
