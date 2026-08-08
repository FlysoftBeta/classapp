import { fetchArticleSidebar } from "@/client/api/articles";
import { fetchConversations } from "@/client/api/conversations";
import { session } from "@/client/lib/remote/session";
import { offlineRepository } from "@/client/data/repository";
import { useAppStore } from "@/client/app/appStore";

let conversationGeneration = 0;
let articleGeneration = 0;
let conversationTimer: ReturnType<typeof setTimeout> | null = null;
let articleTimer: ReturnType<typeof setTimeout> | null = null;

export async function refreshConversations(): Promise<void> {
  if (!session.getToken()) return;
  const generation = ++conversationGeneration;
  const { dispatch, conversations } = useAppStore.getState();
  try {
    if (conversations.length === 0) {
      const cached = await offlineRepository.getConversations();
      if (cached.length && generation === conversationGeneration) {
        dispatch({ type: "SET_CONVERSATIONS", entries: cached });
      }
    }
    const entries = await fetchConversations();
    if (generation !== conversationGeneration) return;
    dispatch({ type: "SET_CONVERSATIONS", entries });
  } catch {
    // Cached state remains usable while the transport is unavailable.
  }
}

export async function refreshArticleSidebar(): Promise<void> {
  if (!session.getToken()) return;
  const generation = ++articleGeneration;
  const { dispatch, articleSidebar } = useAppStore.getState();
  try {
    if (articleSidebar.articles.length === 0) {
      const cached = await offlineRepository.getArticleList();
      if (cached.length && generation === articleGeneration) {
        dispatch({
          type: "SET_ARTICLE_SIDEBAR",
          payload: {
            current_article_id: null,
            articles: cached.filter(
              (article) => article.current_offset > 0 || article.is_bookmarked,
            ),
          },
        });
      }
    }
    const data = await fetchArticleSidebar();
    if (generation !== articleGeneration || !data) return;
    dispatch({ type: "SET_ARTICLE_SIDEBAR", payload: data });
  } catch {
    // Cached state remains usable while the transport is unavailable.
  }
}

export function scheduleConversationRefresh(): void {
  if (conversationTimer) clearTimeout(conversationTimer);
  conversationTimer = setTimeout(() => {
    conversationTimer = null;
    void refreshConversations();
  }, 120);
}

export function scheduleArticleRefresh(): void {
  if (articleTimer) clearTimeout(articleTimer);
  articleTimer = setTimeout(() => {
    articleTimer = null;
    void refreshArticleSidebar();
  }, 120);
}
