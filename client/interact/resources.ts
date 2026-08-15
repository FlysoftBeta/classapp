import { fetchArticleSidebar } from "@/client/interact/articles";
import {
  fetchConversationAccess,
  fetchConversations,
} from "@/client/interact/conversations";
import { currentActorRepository as offlineRepository } from "@/client/interact/actorContext";
import { session } from "./remote/session";
import { useApplicationStore } from "./appStore";
import { captureDetachedClientIncident } from "./clientIncidents";
import { fetchAiSidebar } from "@/client/interact/ai";
import { hasFeature } from "@/shared/features";

class RefreshCoordinator {
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly run: (generation: number) => Promise<void>) {}

  refresh(): Promise<void> {
    const generation = ++this.generation;
    return this.run(generation);
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  schedule(delay = 120): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, delay);
  }

  invalidate(): void {
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

const conversations = new RefreshCoordinator(async (generation) => {
  if (!session.getToken()) return;
  const state = useApplicationStore.getState();
  if (!state.conversations.length) {
    const cached = await offlineRepository.getConversations();
    if (cached.length && conversations.isCurrent(generation)) {
      useApplicationStore.getState().setConversations(cached);
    }
  }
  try {
    const entries = await fetchConversations();
    if (conversations.isCurrent(generation)) {
      useApplicationStore.getState().setConversations(entries);
    }
  } catch (error) {
    captureDetachedClientIncident("resource.conversations", error);
    // The local snapshot remains the usable projection.
  }
});

const conversationAccess = new RefreshCoordinator(async (generation) => {
  if (!session.getToken()) return;
  try {
    const entries = await fetchConversationAccess();
    if (conversationAccess.isCurrent(generation)) {
      useApplicationStore.getState().setConversations(entries);
    }
  } catch (error) {
    captureDetachedClientIncident("resource.conversation-access", error);
    // The previous access projection remains usable until the next recovery.
  }
});

const articleSidebar = new RefreshCoordinator(async (generation) => {
  if (!session.getToken()) return;
  const state = useApplicationStore.getState();
  if (!state.articleSidebar.articles.length) {
    const cached = await offlineRepository.getArticleList();
    if (cached.length && articleSidebar.isCurrent(generation)) {
      useApplicationStore.getState().setArticleSidebar({
        current_article_id: null,
        articles: cached.filter(
          (article) => article.current_offset > 0 || article.is_bookmarked,
        ),
      });
    }
  }
  try {
    const payload = await fetchArticleSidebar();
    if (payload && articleSidebar.isCurrent(generation)) {
      useApplicationStore.getState().setArticleSidebar(payload);
    }
  } catch (error) {
    captureDetachedClientIncident("resource.article-sidebar", error);
    // The local snapshot remains the usable projection.
  }
});

const aiSidebar = new RefreshCoordinator(async (generation) => {
  if (!session.getToken()) return;
  const store = useApplicationStore.getState();
  if (!hasFeature(store.user, "ai")) {
    store.setAiSidebar({
      conversations: [],
      credits: {
        available: 0,
        reserved: 0,
        top_up: 0,
        plan: {
          active: false,
          starts_at: null,
          ends_at: null,
          daily: { allowance: 0, used: 0, remaining: 0, used_percent: 0 },
          weekly: { allowance: 0, used: 0, remaining: 0, used_percent: 0 },
        },
      },
      status: { available: false, error: "未启用 AI 功能" },
    });
    return;
  }
  try {
    const payload = await fetchAiSidebar();
    if (aiSidebar.isCurrent(generation)) {
      useApplicationStore.getState().setAiSidebar(payload);
    }
  } catch (error) {
    captureDetachedClientIncident("resource.ai-sidebar", error);
  }
});

export const resourceQueries = {
  refreshConversations: () => conversations.refresh(),
  refreshConversationAccess: () => conversationAccess.refresh(),
  refreshArticleSidebar: () => articleSidebar.refresh(),
  refreshAiSidebar: () => aiSidebar.refresh(),
  scheduleConversations: () => conversations.schedule(),
  scheduleArticleSidebar: () => articleSidebar.schedule(),
  scheduleAiSidebar: () => aiSidebar.schedule(),
  invalidate: () => {
    conversations.invalidate();
    conversationAccess.invalidate();
    articleSidebar.invalidate();
    aiSidebar.invalidate();
  },
};
