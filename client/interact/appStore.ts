import { create } from "zustand";
import type {
  User,
  AiConversation,
  AiCreditBalance,
} from "@/shared/types/api";
import type { Article, Conversation } from "@/client/interact/presentation";
import type {
  AppStatePayload,
  ArticleSidebarUpdatedPayload,
  AiRunUpdatedPayload,
} from "@/shared/types/events";
import type { ActionData } from "@/shared/protocol/actions";
import { dmConvId } from "@/shared/conversations/id";
import {
  appStateFromPayload,
  type AppRoute,
  type AppState,
  type OobeState,
} from "./types";

interface ApplicationStore {
  appState: AppState;
  user: User | null;
  token: string;
  authEpoch: number;
  appDisable: AppStatePayload["app"];
  route: AppRoute;
  conversations: Conversation[];
  articleSidebar: ArticleSidebarView;
  aiConversations: AiConversation[];
  aiCredits: AiCreditBalance;
  aiStatus: ActionData<"fetchAiSidebarAction">["status"];
  online: boolean;
  loginLoading: boolean;
  loginError: string;
  oobe: OobeState | null;
  oobeHandle: string;
  oobeUsername: string;

  applyServerState(payload: AppStatePayload): void;
  setSession(token: string, user: User): void;
  clearSession(): void;
  setAppState(value: AppState): void;
  setAppDisable(value: AppStatePayload["app"]): void;
  setOnline(value: boolean): void;
  patchUser(user: User): void;
  navigate(route: AppRoute): void;
  setConversations(entries: Conversation[]): void;
  applyConversation(payload: ConversationDelta): void;
  startDm(peerId: string, peerName: string, handle?: string | null): void;
  setArticleSidebar(payload: ArticleSidebarView): void;
  applyArticleSidebar(payload: ArticleSidebarUpdatedPayload): void;
  setCurrentArticle(id: string | null): void;
  setAiSidebar(payload: ActionData<"fetchAiSidebarAction">): void;
  applyAiRun(payload: AiRunUpdatedPayload): void;
  setLoginLoading(value: boolean): void;
  setLoginError(value: string): void;
  setOobe(value: OobeState | null): void;
  patchOobeFields(fields: { handle?: string; username?: string }): void;
}

function sortConversations(entries: Conversation[]): Conversation[] {
  return [...entries].sort((left, right) => {
    if (!!left.pinned !== !!right.pinned) return right.pinned - left.pinned;
    if (left.last_at && right.last_at)
      return right.last_at.localeCompare(left.last_at);
    if (left.last_at) return -1;
    if (right.last_at) return 1;
    return left.name.localeCompare(right.name);
  });
}

function mergeConversation(
  entries: Conversation[],
  incoming: Conversation,
): Conversation[] {
  const index = entries.findIndex(
    (entry) => entry.type === incoming.type && entry.id === incoming.id,
  );
  const next = [...entries];
  if (index < 0) next.push(incoming);
  else next[index] = incoming;
  return sortConversations(next);
}

interface ArticleSidebarView {
  current_article_id: string | null;
  articles: Article[];
}

interface ConversationDelta {
  entry?: Conversation;
  removed?: { type: "group" | "dm"; id: string };
  refresh?: true;
}

function sortSidebar(payload: ArticleSidebarView): ArticleSidebarView {
  return {
    ...payload,
    articles: [...payload.articles].sort((left, right) =>
      (right.last_read_at ?? right.created_at).localeCompare(
        left.last_read_at ?? left.created_at,
      ),
    ),
  };
}

const EMPTY_SIDEBAR: ArticleSidebarView = {
  current_article_id: null,
  articles: [],
};

const EMPTY_AI_CREDITS: AiCreditBalance = {
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
};

function sortAiConversations(entries: AiConversation[]): AiConversation[] {
  return [...entries].sort((left, right) =>
    right.updated_at.localeCompare(left.updated_at),
  );
}

/** Application presentation state. Durable entities stay in client/data. */
export const useApplicationStore = create<ApplicationStore>((set, get) => ({
  appState: "loading",
  user: null,
  token: "",
  authEpoch: 0,
  appDisable: { disabled: false, reason: null },
  route: { view: "chat", conversation: null },
  conversations: [],
  articleSidebar: EMPTY_SIDEBAR,
  aiConversations: [],
  aiCredits: EMPTY_AI_CREDITS,
  aiStatus: { available: false, error: "AI 尚未加载" },
  online: false,
  loginLoading: false,
  loginError: "",
  oobe: null,
  oobeHandle: "",
  oobeUsername: "",

  applyServerState: (payload) => {
    const state = get();
    const sessionDead = !payload.session_valid || !payload.user;
    if (sessionDead && state.token && !payload.client_invalid) {
      return;
    }
    set({
      appState: appStateFromPayload(payload),
      appDisable: payload.app,
      user: sessionDead ? null : payload.user,
      token: sessionDead ? "" : state.token,
      authEpoch: sessionDead ? state.authEpoch + 1 : state.authEpoch,
      ...(sessionDead
        ? {
            conversations: [],
            articleSidebar: EMPTY_SIDEBAR,
            aiConversations: [],
            aiCredits: EMPTY_AI_CREDITS,
            aiStatus: { available: false, error: "AI 尚未加载" },
            route: { view: "chat", conversation: null } as AppRoute,
          }
        : {}),
    });
  },
  setSession: (token, user) =>
    set((state) => ({ token, user, authEpoch: state.authEpoch + 1 })),
  clearSession: () =>
    set((state) => ({
      user: null,
      token: "",
      authEpoch: state.authEpoch + 1,
      conversations: [],
      articleSidebar: EMPTY_SIDEBAR,
      aiConversations: [],
      aiCredits: EMPTY_AI_CREDITS,
      aiStatus: { available: false, error: "AI 尚未加载" },
      route: { view: "chat", conversation: null },
      appDisable: { disabled: false, reason: null },
      oobe: null,
    })),
  setAppState: (appState) => set({ appState }),
  setAppDisable: (appDisable) => set({ appDisable }),
  setOnline: (online) => set({ online }),
  patchUser: (user) => set({ user }),
  navigate: (route) => set({ route }),
  setConversations: (entries) => {
    const route = get().route;
    const selected = route.view === "chat" ? route.conversation : null;
    const exists =
      !selected ||
      entries.some(
        (entry) => entry.type === selected.type && entry.id === selected.id,
      );
    set({
      conversations: sortConversations(entries),
      route: exists ? route : { view: "chat", conversation: null },
    });
  },
  applyConversation: (payload) => {
    if (payload.refresh) return;
    const state = get();
    if (payload.removed) {
      const removed = payload.removed;
      const selected =
        state.route.view === "chat" &&
        state.route.conversation?.type === removed.type &&
        state.route.conversation.id === removed.id;
      set({
        conversations: state.conversations.filter(
          (entry) => !(entry.type === removed.type && entry.id === removed.id),
        ),
        ...(selected
          ? { route: { view: "chat", conversation: null } as AppRoute }
          : {}),
      });
      return;
    }
    if (payload.entry) {
      set({
        conversations: mergeConversation(state.conversations, payload.entry),
      });
    }
  },
  startDm: (peerId, peerName, handle) => {
    const state = get();
    if (!state.user) return;
    const exists = state.conversations.some(
      (entry) => entry.type === "dm" && entry.id === peerId,
    );
    const entry: Conversation = {
      conv_id: dmConvId(state.user.id, peerId),
      revision: 0,
      type: "dm",
      group_type: null,
      id: peerId,
      handle: handle ?? null,
      name: peerName,
      has_password: 0,
      members_hidden: 0,
      admin_only: 0,
      no_leave: 0,
      can_post: true,
      can_leave: false,
      last_message: null,
      last_at: null,
      last_read_post_id: null,
      last_read_post_sequence: 0,
      read_updated_at_ms: 0,
      first_unread_post_id: null,
      unread_count: 0,
      pinned: 0,
      pinned_updated_at_ms: 0,
      muted: 0,
      muted_updated_at_ms: 0,
    };
    set({
      route: { view: "chat", conversation: { type: "dm", id: peerId } },
      conversations: exists
        ? state.conversations
        : [entry, ...state.conversations],
    });
  },
  setArticleSidebar: (payload) => set({ articleSidebar: sortSidebar(payload) }),
  applyArticleSidebar: (payload) => {
    if (payload.refresh) return;
    const state = get();
    let articles = state.articleSidebar.articles;
    let current = state.articleSidebar.current_article_id;
    if (payload.removed) {
      articles = articles.filter(
        (entry) => entry.id !== payload.removed!.article_id,
      );
    }
    if (payload.entry) {
      const index = articles.findIndex(
        (entry) => entry.id === payload.entry!.id,
      );
      articles = [...articles];
      if (index < 0) articles.push(payload.entry);
      else articles[index] = payload.entry;
    }
    if (payload.current_article_id !== undefined)
      current = payload.current_article_id;
    const route =
      payload.removed &&
      state.route.view === "reader" &&
      state.route.articleId === payload.removed.article_id
        ? ({
            view: "articles",
            conversation: state.route.conversation,
          } as AppRoute)
        : state.route;
    set({
      articleSidebar: sortSidebar({ current_article_id: current, articles }),
      route,
    });
  },
  setCurrentArticle: (current_article_id) =>
    set((state) => ({
      articleSidebar: { ...state.articleSidebar, current_article_id },
    })),
  setAiSidebar: (payload) =>
    set({
      aiConversations: sortAiConversations(payload.conversations),
      aiCredits: payload.credits,
      aiStatus: payload.status,
    }),
  applyAiRun: (payload) =>
    set((state) => {
      const index = state.aiConversations.findIndex(
        (entry) => entry.id === payload.conversation.id,
      );
      const conversations = [...state.aiConversations];
      if (index < 0) conversations.push(payload.conversation);
      else conversations[index] = payload.conversation;
      return { aiConversations: sortAiConversations(conversations) };
    }),
  setLoginLoading: (loginLoading) => set({ loginLoading }),
  setLoginError: (loginError) => set({ loginError }),
  setOobe: (oobe) => set({ oobe }),
  patchOobeFields: ({ handle, username }) =>
    set((state) => ({
      oobeHandle: handle ?? state.oobeHandle,
      oobeUsername: username ?? state.oobeUsername,
    })),
}));
