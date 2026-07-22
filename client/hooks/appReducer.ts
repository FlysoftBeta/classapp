import type {
  User,
  AppDisableState,
  AppDisableReason,
  ArticleWithMeta,
  ArticleSidebarPayload,
  Conversation,
} from "@/shared/types/api";
import type {
  ConvUpdatedPayload,
  AppStatePayload,
  ArticleSidebarUpdatedPayload,
  ArticleListUpdatedPayload,
} from "@/shared/types/events";

export type AppState =
  "loading" | "konami" | "login" | "oobe" | "app_locked" | "app";

export interface OobeState {
  oobe_token: string;
  pin1: string;
  pin2: string;
  step: "pin1" | "pin2_prompt" | "pin2" | "handle" | "username";
  error: string;
  submitting: boolean;
}

export type ConvEntry = Conversation;

export interface SelectedKey {
  type: "group" | "dm";
  id: string;
}

export type AppRoute =
  | { view: "chat"; conversation: SelectedKey | null }
  | { view: "settings" }
  | { view: "admin" }
  | { view: "articles" }
  | {
      view: "reader";
      articleId: string;
      from: "chat" | "articles";
    }
  | { view: "learning" }
  | { view: "word-learning" }
  | { view: "wrong-words" }
  | { view: "clear-wrong" }
  | { view: "mastered-words" };

export type ViewType = AppRoute["view"];

export type {
  AppStatePayload,
  PostStreamEvent,
  UserConfigChangedEvent,
} from "@/shared/types/events";

export interface ArticleListState {
  articles: ArticleWithMeta[];
  total: number;
  offset: number;
}

export interface AppStore {
  appState: AppState;
  user: User | null;
  token: string;
  appDisable: AppDisableState;
  route: AppRoute;
  conversations: ConvEntry[];
  loginLoading: boolean;
  loginError: string;
  oobe: OobeState | null;
  oobeHandle: string;
  oobeUsername: string;
  /** Monotonic counter — bump to force remote resubscription. */
  remoteGeneration: number;
  articleSidebar: ArticleSidebarPayload;
  articleList: ArticleListState;
  online: boolean;
}

export type AppAction =
  | { type: "APPLY_STATE"; payload: AppStatePayload }
  | { type: "SET_TOKEN"; token: string; user?: User | null }
  | { type: "LOGOUT" }
  | { type: "CONV_PAYLOAD"; payload: ConvUpdatedPayload }
  | { type: "SET_CONVERSATIONS"; entries: ConvEntry[] }
  | { type: "NAVIGATE"; route: AppRoute }
  | { type: "SET_OOBE"; oobe: OobeState | null }
  | { type: "SET_OOBE_FIELDS"; handle?: string; username?: string }
  | { type: "SET_LOGIN_LOADING"; loading: boolean }
  | { type: "SET_LOGIN_ERROR"; error: string }
  | { type: "SET_APP_STATE"; appState: AppState }
  | { type: "SET_APP_DISABLE"; appDisable: AppDisableState }
  | { type: "PATCH_USER"; user: User }
  | { type: "REMOTE_RESUBSCRIBE" }
  | { type: "SET_ARTICLE_SIDEBAR"; payload: ArticleSidebarPayload }
  | { type: "ARTICLE_SIDEBAR_PAYLOAD"; payload: ArticleSidebarUpdatedPayload }
  | { type: "PATCH_ARTICLE_SIDEBAR_CURRENT"; currentArticleId: string | null }
  | { type: "SET_ARTICLE_LIST"; payload: ArticleListState }
  | { type: "ARTICLE_LIST_PAYLOAD"; payload: ArticleListUpdatedPayload }
  | { type: "SET_ONLINE"; online: boolean }
  | {
      type: "NEW_DM";
      peerId: string;
      peerName: string;
      handle?: string | null;
    };

export function appStateFromPayload(p: AppStatePayload): AppState {
  if (p.konami_locked) return "konami";
  if (!p.session_valid || !p.user) return "login";
  if (p.app.disabled) return "app_locked";
  return "app";
}

function sortConvEntries(entries: ConvEntry[]): ConvEntry[] {
  return [...entries].sort((a, b) => {
    const aPin = a.pinned ? 1 : 0;
    const bPin = b.pinned ? 1 : 0;
    if (aPin !== bPin) return bPin - aPin;
    if (a.last_at && b.last_at) return b.last_at.localeCompare(a.last_at);
    if (a.last_at) return -1;
    if (b.last_at) return 1;
    return a.name.localeCompare(b.name);
  });
}

function mergeConvEntry(prev: ConvEntry[], entry: ConvEntry): ConvEntry[] {
  const idx = prev.findIndex((c) => c.type === entry.type && c.id === entry.id);
  const next =
    idx >= 0
      ? [...prev.slice(0, idx), entry, ...prev.slice(idx + 1)]
      : [...prev, entry];
  return sortConvEntries(next);
}

function sortSidebarArticles(articles: ArticleWithMeta[]): ArticleWithMeta[] {
  return [...articles].sort((a, b) => {
    const ta = a.last_read_at ?? a.created_at;
    const tb = b.last_read_at ?? b.created_at;
    return tb.localeCompare(ta);
  });
}

function mergeSidebarArticle(
  prev: ArticleWithMeta[],
  entry: ArticleWithMeta,
): ArticleWithMeta[] {
  const idx = prev.findIndex((a) => a.id === entry.id);
  const next =
    idx >= 0
      ? [...prev.slice(0, idx), entry, ...prev.slice(idx + 1)]
      : [...prev, entry];
  return sortSidebarArticles(next);
}

export type { AppDisableState, AppDisableReason };

export function deriveSelected(
  conversations: ConvEntry[],
  route: AppRoute,
): ConvEntry | null {
  if (route.view !== "chat") return null;
  const key = route.conversation;
  if (!key) return null;
  return (
    conversations.find((c) => c.type === key.type && c.id === key.id) ?? null
  );
}

export const initialAppStore: AppStore = {
  appState: "loading",
  user: null,
  token: "",
  appDisable: { disabled: false, reason: null },
  route: { view: "chat", conversation: null },
  conversations: [],
  loginLoading: false,
  loginError: "",
  oobe: null,
  oobeHandle: "",
  oobeUsername: "",
  remoteGeneration: 0,
  articleSidebar: { current_article_id: null, articles: [] },
  articleList: { articles: [], total: 0, offset: 0 },
  online: false,
};

export function appReducer(state: AppStore, action: AppAction): AppStore {
  switch (action.type) {
    case "APPLY_STATE": {
      const p = action.payload;
      const nextAppState = appStateFromPayload(p);
      const sessionDead = !p.session_valid || !p.user;
      // Ignore stale anonymous probes (e.g. event refresh fired before tokenRef
      // caught up right after login). Real expiry probes include reason.
      if (sessionDead && state.token && p.reason !== "session_expired") {
        return state;
      }
      return {
        ...state,
        appState: nextAppState,
        appDisable: p.app,
        user: sessionDead ? null : p.user,
        token: sessionDead ? "" : state.token,
        ...(sessionDead
          ? {
              conversations: [],
              articleSidebar: { current_article_id: null, articles: [] },
              articleList: { articles: [], total: 0, offset: 0 },
              route: { view: "chat", conversation: null } as AppRoute,
            }
          : {}),
      };
    }
    case "SET_TOKEN":
      return {
        ...state,
        token: action.token,
        user: action.user !== undefined ? action.user : state.user,
      };
    case "LOGOUT":
      return {
        ...state,
        user: null,
        token: "",
        conversations: [],
        articleSidebar: { current_article_id: null, articles: [] },
        articleList: { articles: [], total: 0, offset: 0 },
        route: { view: "chat", conversation: null },
        appDisable: { disabled: false, reason: null },
        oobe: null,
      };
    case "CONV_PAYLOAD": {
      const payload = action.payload;
      if (payload.refresh) return state;
      if (payload.removed) {
        const { type, id } = payload.removed;
        const route =
          state.route.view === "chat" &&
          state.route.conversation?.type === type &&
          state.route.conversation.id === id
            ? ({ view: "chat", conversation: null } as const)
            : state.route;
        return {
          ...state,
          route,
          conversations: state.conversations.filter(
            (c) => !(c.type === type && c.id === id),
          ),
        };
      }
      if (payload.entry) {
        return {
          ...state,
          conversations: mergeConvEntry(state.conversations, payload.entry),
        };
      }
      return state;
    }
    case "SET_CONVERSATIONS": {
      const selected =
        state.route.view === "chat" ? state.route.conversation : null;
      const selectionStillExists =
        !selected ||
        action.entries.some(
          (entry) => entry.type === selected.type && entry.id === selected.id,
        );
      return {
        ...state,
        conversations: action.entries,
        route: selectionStillExists
          ? state.route
          : { view: "chat", conversation: null },
      };
    }
    case "NAVIGATE":
      return { ...state, route: action.route };
    case "SET_OOBE":
      return { ...state, oobe: action.oobe };
    case "SET_OOBE_FIELDS":
      return {
        ...state,
        oobeHandle: action.handle ?? state.oobeHandle,
        oobeUsername: action.username ?? state.oobeUsername,
      };
    case "SET_LOGIN_LOADING":
      return { ...state, loginLoading: action.loading };
    case "SET_LOGIN_ERROR":
      return { ...state, loginError: action.error };
    case "SET_APP_STATE":
      return { ...state, appState: action.appState };
    case "SET_APP_DISABLE":
      return { ...state, appDisable: action.appDisable };
    case "SET_ONLINE":
      return { ...state, online: action.online };
    case "PATCH_USER":
      return { ...state, user: action.user };
    case "REMOTE_RESUBSCRIBE":
      return { ...state, remoteGeneration: state.remoteGeneration + 1 };
    case "SET_ARTICLE_SIDEBAR":
      return { ...state, articleSidebar: action.payload };
    case "ARTICLE_SIDEBAR_PAYLOAD": {
      const payload = action.payload;
      if (payload.refresh) return state;
      let articles = state.articleSidebar.articles;
      let currentArticleId = state.articleSidebar.current_article_id;
      if (payload.removed) {
        articles = articles.filter((a) => a.id !== payload.removed!.article_id);
      }
      if (payload.entry) {
        articles = mergeSidebarArticle(articles, payload.entry);
      }
      if (payload.current_article_id !== undefined) {
        currentArticleId = payload.current_article_id;
      }
      const route =
        payload.removed &&
        state.route.view === "reader" &&
        state.route.articleId === payload.removed.article_id
          ? ({ view: "articles" } as const)
          : state.route;
      return {
        ...state,
        route,
        articleSidebar: { current_article_id: currentArticleId, articles },
      };
    }
    case "PATCH_ARTICLE_SIDEBAR_CURRENT":
      return {
        ...state,
        articleSidebar: {
          ...state.articleSidebar,
          current_article_id: action.currentArticleId,
        },
      };
    case "SET_ARTICLE_LIST":
      return { ...state, articleList: action.payload };
    case "ARTICLE_LIST_PAYLOAD": {
      const payload = action.payload;
      if (payload.refresh) return state;
      let { articles, total } = state.articleList;
      const { offset } = state.articleList;
      if (payload.removed) {
        const id = payload.removed.article_id;
        if (articles.some((a) => a.id === id)) {
          articles = articles.filter((a) => a.id !== id);
        }
        total = Math.max(0, total - 1);
      }
      if (payload.entry) {
        const entry = payload.entry;
        const idx = articles.findIndex((a) => a.id === entry.id);
        if (idx >= 0) {
          articles = [
            ...articles.slice(0, idx),
            entry,
            ...articles.slice(idx + 1),
          ];
        } else if (payload.created) {
          total += 1;
          if (offset === 0) {
            articles = [entry, ...articles].slice(0, 50);
          }
        }
      }
      return { ...state, articleList: { articles, total, offset } };
    }
    case "NEW_DM": {
      const exists = state.conversations.some(
        (d) => d.type === "dm" && d.id === action.peerId,
      );
      const entry: ConvEntry = {
        type: "dm",
        id: action.peerId,
        handle: action.handle ?? null,
        name: action.peerName,
        has_password: 0,
        members_hidden: 0,
        admin_only: 0,
        no_leave: 0,
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
      return {
        ...state,
        route: {
          view: "chat",
          conversation: { type: "dm", id: action.peerId },
        },
        conversations: exists
          ? state.conversations
          : [entry, ...state.conversations],
        remoteGeneration: state.remoteGeneration + 1,
      };
    }
    default:
      return state;
  }
}
