import { useEffect, useCallback, useRef, useMemo, useState } from "react";
import { USER_CONFIG } from "@/shared/userConfig/keys";
import type { EventData } from "@/shared/protocol/events";
import { setClientInvalidHandler, setClientToken } from "@/client/api/runtime";
import { client } from "@/client/remote/Client";
import {
  probeAppState,
  autoLogin,
  loginPin,
  completeOobe,
  getClientMe,
  logout as apiLogout,
  patchClientMe,
} from "@/client/api/auth";
import { fetchConversations } from "@/client/api/conversations";
import { fetchArticleSidebar } from "@/client/api/articles";
import {
  deriveSelected,
  type AppState,
  type AppRoute,
  type ViewType,
  type OobeState,
  type ConvEntry,
  type PostStreamEvent,
  type AppDisableState,
  type AppDisableReason,
  type AppStatePayload,
  type UserConfigChangedEvent,
} from "./appReducer";
import { useAppStore } from "@/client/store/appStore";
import { offlineRepository } from "@/client/resource/offlineRepository";
import {
  syncOfflineContent,
  syncPendingMutations,
} from "@/client/resource/offlineSync";

export type {
  AppState,
  AppRoute,
  ViewType,
  OobeState,
  ConvEntry,
  PostStreamEvent,
  AppDisableState,
  AppDisableReason,
  UserConfigChangedEvent,
};

export function useAppLogic() {
  const store = useAppStore();
  const dispatch = useAppStore((state) => state.dispatch);
  const [clientId, setClientId] = useState("");
  const [articleListRevision, setArticleListRevision] = useState(0);

  const tokenRef = useRef("");
  const appStateRef = useRef<AppState>("loading");
  const convLoadGenRef = useRef(0);
  const articleSidebarLoadGenRef = useRef(0);
  const articleSidebarRefreshTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const convRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const remoteRecoveryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const remoteRecoveryRunRef = useRef<Promise<void> | null>(null);
  const postListenersRef = useRef(new Set<(evt: PostStreamEvent) => void>());
  const configListenersRef = useRef(
    new Set<(evt: UserConfigChangedEvent) => void>(),
  );

  const selected = useMemo(
    () => deriveSelected(store.conversations, store.route),
    [store.conversations, store.route],
  );

  useEffect(() => {
    tokenRef.current = store.token;
    setClientToken(store.token);
  }, [store.token]);

  useEffect(() => {
    offlineRepository.setUserScope(store.user?.id ?? null);
  }, [store.user?.id]);

  useEffect(() => {
    appStateRef.current = store.appState;
  }, [store.appState]);

  // ── Client-invalid global handler ─────────────────────────────────────────
  useEffect(() => {
    setClientInvalidHandler(() => {
      dispatch({ type: "LOGOUT" });
      dispatch({ type: "SET_APP_STATE", appState: "login" });
    });
  }, [dispatch]);

  // ── Anti-exit history stuffing ───────────────────────────────────────────
  useEffect(() => {
    if (store.appState !== "app") return;
    for (let i = 0; i < 10; i++) {
      window.history.pushState({ _antiExit: true }, "", window.location.href);
    }
  }, [store.appState]);

  const lockKonami = useCallback(async () => {
    try {
      await patchClientMe(true);
    } catch {
      /* ignore */
    }
    dispatch({ type: "SET_APP_STATE", appState: "konami" });
  }, [dispatch]);

  useEffect(() => {
    const onPopState = (e: PopStateEvent) => {
      const state = e.state as { _antiExit?: boolean } | null;
      if (!state?._antiExit) return;
      window.history.pushState({ _antiExit: true }, "", window.location.href);
      if (appStateRef.current === "app") lockKonami();
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [lockKonami]);

  const loadConversations = useCallback(async () => {
    if (!tokenRef.current) return;
    const gen = ++convLoadGenRef.current;
    try {
      if (useAppStore.getState().conversations.length === 0) {
        const cached = await offlineRepository.getConversations();
        if (cached.length && gen === convLoadGenRef.current) {
          dispatch({ type: "SET_CONVERSATIONS", entries: cached });
        }
      }
      const entries = await fetchConversations();
      if (gen !== convLoadGenRef.current) return;
      dispatch({ type: "SET_CONVERSATIONS", entries });
    } catch {
      /* network glitch */
    }
  }, [dispatch]);

  const loadArticleSidebar = useCallback(async () => {
    if (!tokenRef.current) return;
    const gen = ++articleSidebarLoadGenRef.current;
    try {
      if (useAppStore.getState().articleSidebar.articles.length === 0) {
        const cached = await offlineRepository.getArticleList();
        if (cached.length && gen === articleSidebarLoadGenRef.current) {
          dispatch({
            type: "SET_ARTICLE_SIDEBAR",
            payload: {
              current_article_id: null,
              articles: cached.filter(
                (article) =>
                  article.current_offset > 0 || article.is_bookmarked,
              ),
            },
          });
        }
      }
      const data = await fetchArticleSidebar();
      if (gen !== articleSidebarLoadGenRef.current || !data) return;
      dispatch({ type: "SET_ARTICLE_SIDEBAR", payload: data });
    } catch {
      /* network glitch */
    }
  }, [dispatch]);

  const scheduleLoadArticleSidebar = useCallback(() => {
    if (articleSidebarRefreshTimerRef.current) {
      clearTimeout(articleSidebarRefreshTimerRef.current);
    }
    articleSidebarRefreshTimerRef.current = setTimeout(() => {
      articleSidebarRefreshTimerRef.current = null;
      if (tokenRef.current) loadArticleSidebar();
    }, 120);
  }, [loadArticleSidebar]);

  const scheduleLoadConversations = useCallback(() => {
    if (convRefreshTimerRef.current) clearTimeout(convRefreshTimerRef.current);
    convRefreshTimerRef.current = setTimeout(() => {
      convRefreshTimerRef.current = null;
      if (tokenRef.current) loadConversations();
    }, 120);
  }, [loadConversations]);

  const subscribePostEvents = useCallback(
    (fn: (evt: PostStreamEvent) => void) => {
      postListenersRef.current.add(fn);
      return () => {
        postListenersRef.current.delete(fn);
      };
    },
    [],
  );

  const notifyPostListeners = useCallback((evt: PostStreamEvent) => {
    for (const fn of postListenersRef.current) {
      try {
        fn(evt);
      } catch {
        /* ignore */
      }
    }
  }, []);

  const subscribeConfigEvents = useCallback(
    (fn: (evt: UserConfigChangedEvent) => void) => {
      configListenersRef.current.add(fn);
      return () => {
        configListenersRef.current.delete(fn);
      };
    },
    [],
  );

  const notifyConfigListeners = useCallback((evt: UserConfigChangedEvent) => {
    for (const fn of configListenersRef.current) {
      try {
        fn(evt);
      } catch {
        /* ignore */
      }
    }
  }, []);

  const probeState = useCallback(
    async (opts?: { touch?: boolean }): Promise<AppStatePayload | null> => {
      return probeAppState(opts);
    },
    [],
  );

  const applyState = useCallback(
    (p: AppStatePayload) => {
      dispatch({ type: "APPLY_STATE", payload: p });
    },
    [dispatch],
  );

  // ── WebSocket EventBus ──────────────────────────────────────────────────
  useEffect(() => {
    if (store.appState === "loading") return;
    client.connect();

    const refresh = () => {
      probeState().then((p) => {
        if (p) applyState(p);
      });
    };

    const refreshIdleLocked = () => {
      probeState({ touch: false }).then((p) => {
        if (p) applyState(p);
      });
    };

    const onConvUpdated = () => scheduleLoadConversations();

    const onRemoteResubscribe = () => {
      client.setToken(tokenRef.current);
      dispatch({ type: "REMOTE_RESUBSCRIBE" });
    };

    const onMuted = (data: EventData<"user.muted_changed">) => {
      if (store.user) {
        dispatch({
          type: "PATCH_USER",
          user: {
            ...store.user,
            is_muted: data.is_muted,
            muted_until: data.muted_until,
          },
        });
      } else {
        refresh();
      }
    };

    const onProfile = (data: EventData<"user.profile_changed">) => {
      dispatch({ type: "PATCH_USER", user: data.user });
    };

    const onArticleSidebarUpdated = () => scheduleLoadArticleSidebar();

    const onArticleListUpdated = () => {
      setArticleListRevision((revision) => revision + 1);
    };

    const onUserConfigChanged = (data: EventData<"user.config_changed">) => {
      if (data.key === USER_CONFIG.ACTIVE_ARTICLE_ID) {
        dispatch({
          type: "PATCH_ARTICLE_SIDEBAR_CURRENT",
          currentArticleId: data.value,
        });
      }
      notifyConfigListeners(data);
    };

    const unsubscribers = [
      client.subscribe("client.lock_changed", refresh),
      client.subscribe("client.idle_locked", refreshIdleLocked),
      client.subscribe("client.deleted", () => {
        dispatch({ type: "LOGOUT" });
        dispatch({ type: "SET_APP_STATE", appState: "login" });
      }),
      client.subscribe("user.banned", refresh),
      client.subscribe("user.unbanned", refresh),
      client.subscribe("user.muted_changed", onMuted),
      client.subscribe("user.profile_changed", onProfile),
      client.subscribe("system.lock_changed", refresh),
      client.subscribe("remote.resubscribe", onRemoteResubscribe),
      client.subscribe("conv.updated", onConvUpdated),
      client.subscribe("post.created", (data) =>
        notifyPostListeners({ kind: "post.created", data }),
      ),
      client.subscribe("post.updated", (data) =>
        notifyPostListeners({ kind: "post.updated", data }),
      ),
      client.subscribe("post.deleted", (data) =>
        notifyPostListeners({ kind: "post.deleted", data }),
      ),
      client.subscribe("article.sidebar_updated", onArticleSidebarUpdated),
      client.subscribe("article.list_updated", onArticleListUpdated),
      client.subscribe("user.config_changed", onUserConfigChanged),
    ];
    dispatch({ type: "SET_ONLINE", online: client.isConnected() });
    const offConnection = client.onConnectionChange((connected) => {
      dispatch({ type: "SET_ONLINE", online: connected });
      if (!connected) return;
      if (remoteRecoveryTimerRef.current) {
        clearTimeout(remoteRecoveryTimerRef.current);
      }
      remoteRecoveryTimerRef.current = setTimeout(() => {
        remoteRecoveryTimerRef.current = null;
        if (remoteRecoveryRunRef.current) return;
        const token = tokenRef.current;
        const run = (async () => {
          const payload = await probeState().catch(() => null);
          if (payload) applyState(payload);
          if (token) {
            await syncOfflineContent();
            await Promise.all([loadConversations(), loadArticleSidebar()]);
          }
          dispatch({ type: "REMOTE_RESUBSCRIBE" });
        })().finally(() => {
          if (remoteRecoveryRunRef.current === run) {
            remoteRecoveryRunRef.current = null;
          }
        });
        remoteRecoveryRunRef.current = run;
      }, 150);
    });

    return () => {
      if (remoteRecoveryTimerRef.current) {
        clearTimeout(remoteRecoveryTimerRef.current);
        remoteRecoveryTimerRef.current = null;
      }
      offConnection();
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.token, store.appState !== "loading", store.remoteGeneration]);

  // ── Periodic heartbeat (idle lock + state sync) ──────────────────────────
  useEffect(() => {
    if (store.appState !== "app" || !store.token) return;
    const id = setInterval(() => {
      probeState().then((p) => {
        if (p) applyState(p);
      });
      void syncPendingMutations().catch(() => {});
    }, 120_000);
    return () => clearInterval(id);
  }, [store.appState, store.token, probeState, applyState]);

  // ── Auto-login on mount ──────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const me = await getClientMe();
        if (me.res.ok && "client_id" in me.data) {
          setClientId(me.data.client_id ?? "");
        }
        const auto = await autoLogin();

        if (auto.banned) {
          dispatch({
            type: "SET_APP_DISABLE",
            appDisable: {
              disabled: true,
              reason: "banned",
              banned_until: auto.banned_until,
              username: auto.username,
            },
          });
          dispatch({ type: "SET_APP_STATE", appState: "app_locked" });
          return;
        }

        if (auto.user && auto.token) {
          offlineRepository.setUserScope(auto.user.id);
          tokenRef.current = auto.token;
          setClientToken(auto.token);
          dispatch({
            type: "SET_TOKEN",
            token: auto.token,
            user: auto.user as AppStatePayload["user"],
          });
          await loadConversations();
          await loadArticleSidebar();
        }

        const p = await probeState();
        if (p) applyState(p);
        else
          dispatch({
            type: "SET_APP_STATE",
            appState: auto.konami_locked ? "konami" : "login",
          });
      } catch {
        dispatch({ type: "SET_APP_STATE", appState: "login" });
      }
    })();
  }, [dispatch, loadConversations, loadArticleSidebar, probeState, applyState]);

  // ── 30s auto-lock from app_locked back to konami ─────────────────────────
  useEffect(() => {
    if (store.appState !== "app_locked") return;
    const id = setTimeout(() => lockKonami(), 30_000);
    return () => clearTimeout(id);
  }, [store.appState, lockKonami]);

  const unlockKonami = useCallback(async () => {
    try {
      const result = await patchClientMe(false);
      if (result.ok && !result.data.ok && "access_required" in result.data) {
        setClientId(result.data.client_id);
        return result.data.client_id;
      }
    } catch {
      return "";
    }
    const p = await probeState();
    if (p) applyState(p);
    else
      dispatch({
        type: "SET_APP_STATE",
        appState: tokenRef.current ? "app" : "login",
      });
    return null;
  }, [dispatch, probeState, applyState]);

  const handleLoginPin = useCallback(
    async (pin: string) => {
      dispatch({ type: "SET_LOGIN_ERROR", error: "" });
      dispatch({ type: "SET_LOGIN_LOADING", loading: true });
      try {
        const { res, data: rawData } = await loginPin(pin);
        const data = rawData as Record<string, unknown>;

        if (data.banned) {
          dispatch({
            type: "SET_APP_DISABLE",
            appDisable: {
              disabled: true,
              reason: "banned",
              banned_until: data.banned_until as string,
              username: data.username as string,
            },
          });
          dispatch({ type: "SET_APP_STATE", appState: "app_locked" });
          return;
        }

        if (!res.ok) {
          dispatch({
            type: "SET_LOGIN_ERROR",
            error:
              (typeof data.error === "string" && data.error) ||
              "PIN 错误，请重试；如需帮助请联系管理员。",
          });
          return;
        }

        if (data.needs_oobe) {
          dispatch({
            type: "SET_OOBE",
            oobe: {
              oobe_token: data.oobe_token as string,
              pin1: "",
              pin2: "",
              step: "pin1",
              error: "",
              submitting: false,
            },
          });
          dispatch({ type: "SET_OOBE_FIELDS", handle: "", username: "" });
          dispatch({ type: "SET_APP_STATE", appState: "oobe" });
          return;
        }

        tokenRef.current = data.token as string;
        offlineRepository.setUserScope(
          (data.user as AppStatePayload["user"])!.id,
        );
        dispatch({
          type: "SET_TOKEN",
          token: data.token as string,
          user: data.user as AppStatePayload["user"],
        });
        await loadConversations();
        await loadArticleSidebar();

        const p = await probeState();
        if (p) applyState(p);
        else dispatch({ type: "SET_APP_STATE", appState: "app" });
      } catch {
        dispatch({
          type: "SET_LOGIN_ERROR",
          error: "无法连接服务器，请检查网络后重试。",
        });
      } finally {
        dispatch({ type: "SET_LOGIN_LOADING", loading: false });
      }
    },
    [dispatch, loadConversations, loadArticleSidebar, probeState, applyState],
  );

  const handleOobePin = useCallback(
    (pin: string) => {
      if (!store.oobe) return;
      if (store.oobe.step === "pin1") {
        dispatch({
          type: "SET_OOBE",
          oobe: { ...store.oobe, pin1: pin, step: "pin2_prompt", error: "" },
        });
      } else if (store.oobe.step === "pin2") {
        dispatch({
          type: "SET_OOBE",
          oobe: { ...store.oobe, pin2: pin, step: "handle", error: "" },
        });
      }
    },
    [dispatch, store.oobe],
  );

  const handleOobeSubmit = useCallback(async () => {
    if (!store.oobe) return;
    dispatch({
      type: "SET_OOBE",
      oobe: { ...store.oobe, submitting: true, error: "" },
    });
    const new_pins = store.oobe.pin2
      ? [store.oobe.pin1, store.oobe.pin2]
      : [store.oobe.pin1];
    try {
      const { res, data } = await completeOobe({
        oobe_token: store.oobe.oobe_token,
        handle: store.oobeHandle.trim(),
        username: store.oobeUsername.trim(),
        new_pins,
      });
      if (!res.ok || "error" in data) {
        dispatch({
          type: "SET_OOBE",
          oobe: {
            ...store.oobe,
            submitting: false,
            error: ("error" in data ? data.error : undefined) || "设置失败",
          },
        });
        return;
      }
      tokenRef.current = data.token;
      offlineRepository.setUserScope(data.user.id);
      dispatch({ type: "SET_TOKEN", token: data.token, user: data.user });
      await loadConversations();
      await loadArticleSidebar();
      dispatch({ type: "SET_OOBE", oobe: null });
      const p = await probeState();
      if (p) applyState(p);
      else dispatch({ type: "SET_APP_STATE", appState: "app" });
    } catch {
      dispatch({
        type: "SET_OOBE",
        oobe: store.oobe
          ? { ...store.oobe, submitting: false, error: "网络错误" }
          : null,
      });
    }
  }, [
    dispatch,
    store.oobe,
    store.oobeHandle,
    store.oobeUsername,
    loadConversations,
    loadArticleSidebar,
    probeState,
    applyState,
  ]);

  const handleLogout = useCallback(async () => {
    try {
      await apiLogout();
    } catch {
      /* ignore */
    }
    dispatch({ type: "LOGOUT" });
    tokenRef.current = "";
    const p = await probeState();
    if (p) applyState(p);
    else dispatch({ type: "SET_APP_STATE", appState: "login" });
  }, [dispatch, probeState, applyState]);

  const handleNewDm = useCallback(
    (peerId: string, peerName: string) => {
      dispatch({ type: "NEW_DM", peerId, peerName });
    },
    [dispatch],
  );

  const handleConversationUpdate = useCallback(() => {
    scheduleLoadConversations();
    dispatch({ type: "REMOTE_RESUBSCRIBE" });
  }, [dispatch, scheduleLoadConversations]);

  const handleLeftGroup = useCallback(
    (groupId: string) => {
      dispatch({
        type: "CONV_PAYLOAD",
        payload: { removed: { type: "group", id: groupId } },
      });
    },
    [dispatch],
  );

  const convGroups = store.conversations.filter((c) => c.type === "group");
  const convDms = store.conversations.filter((c) => c.type === "dm");

  return {
    appState: store.appState,
    setAppState: (s: AppState) =>
      dispatch({ type: "SET_APP_STATE", appState: s }),
    appDisable: store.appDisable,
    online: store.online,

    user: store.user,
    setUser: (u: NonNullable<typeof store.user>) =>
      dispatch({ type: "PATCH_USER", user: u }),
    token: store.token,
    clientId,

    route: store.route,
    navigate: (route: AppRoute) => dispatch({ type: "NAVIGATE", route }),
    selected,
    conversations: store.conversations,
    convGroups,
    convDms,
    articleSidebar: store.articleSidebar,
    articleListRevision,

    loginLoading: store.loginLoading,
    loginError: store.loginError,
    oobe: store.oobe,
    setOobe: (o: OobeState | null) => dispatch({ type: "SET_OOBE", oobe: o }),
    oobeHandle: store.oobeHandle,
    setOobeHandle: (h: string) =>
      dispatch({ type: "SET_OOBE_FIELDS", handle: h }),
    oobeUsername: store.oobeUsername,
    setOobeUsername: (n: string) =>
      dispatch({ type: "SET_OOBE_FIELDS", username: n }),

    handleLoginPin,
    handleOobePin,
    handleOobeSubmit,
    handleLogout,
    handleNewDm,
    handleConversationUpdate,
    handleLeftGroup,
    subscribePostEvents,
    subscribeConfigEvents,

    lockKonami,
    unlockKonami,
  };
}
