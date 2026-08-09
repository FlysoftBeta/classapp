import { useEffect, useCallback, useRef, useMemo, useState } from "react";
import {
  selectedConversation,
  type AppState,
  type AppRoute,
  type ViewType,
  type OobeState,
  type ConvEntry,
  type PostStreamEvent,
  type AppDisableState,
  type AppDisableReason,
  type UserConfigChangedEvent,
} from "@/client/interact/types";
import { useApplicationStore } from "@/client/interact/appStore";
import { resourceQueries } from "@/client/interact/resources";
import {
  bindRemoteLifecycle,
  bindInvalidSessionHandler,
  startHeartbeat,
} from "@/client/interact/remoteLifecycle";
import {
  acceptOobePin,
  bootstrapSession,
  lockSession,
  loginWithPin,
  logoutSession,
  submitOobe,
  unlockSession,
} from "@/client/interact/sessionController";
import { configEvents, postEvents } from "@/client/interact/events";

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
  const store = useApplicationStore();
  const [clientId, setClientId] = useState("");
  const [articleListRevision, setArticleListRevision] = useState(0);

  const appStateRef = useRef<AppState>("loading");
  const selected = useMemo(
    () => selectedConversation(store.conversations, store.route),
    [store.conversations, store.route],
  );

  useEffect(() => {
    appStateRef.current = store.appState;
  }, [store.appState]);

  // ── Client-invalid global handler ─────────────────────────────────────────
  useEffect(() => {
    return bindInvalidSessionHandler();
  }, []);

  // ── Anti-exit history stuffing ───────────────────────────────────────────
  useEffect(() => {
    if (store.appState !== "app") return;
    for (let i = 0; i < 10; i++) {
      window.history.pushState({ _antiExit: true }, "", window.location.href);
    }
  }, [store.appState]);

  const lockKonami = useCallback(() => lockSession(), []);

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

  useEffect(() => {
    return bindRemoteLifecycle({
      onArticleListUpdated: () =>
        setArticleListRevision((revision) => revision + 1),
    });
  }, []);

  useEffect(() => {
    return startHeartbeat();
  }, []);

  // ── Auto-login on mount ──────────────────────────────────────────────────
  useEffect(() => {
    void bootstrapSession(setClientId);
  }, []);

  // ── 30s auto-lock from app_locked back to konami ─────────────────────────
  useEffect(() => {
    if (store.appState !== "app_locked") return;
    const id = setTimeout(() => lockKonami(), 30_000);
    return () => clearTimeout(id);
  }, [store.appState, lockKonami]);

  const unlockKonami = useCallback(() => unlockSession(setClientId), []);

  const handleLoginPin = loginWithPin;
  const handleOobePin = acceptOobePin;
  const handleOobeSubmit = submitOobe;
  const handleLogout = logoutSession;

  const handleNewDm = useCallback(
    (peerId: string, peerName: string) => {
      store.startDm(peerId, peerName);
    },
    [store],
  );

  const handleConversationUpdate = useCallback(() => {
    resourceQueries.scheduleConversations();
  }, []);

  const handleLeftGroup = useCallback(
    (groupId: string) => {
      store.applyConversation({ removed: { type: "group", id: groupId } });
    },
    [store],
  );

  const convGroups = store.conversations.filter((c) => c.type === "group");
  const convDms = store.conversations.filter((c) => c.type === "dm");

  return {
    appState: store.appState,
    setAppState: store.setAppState,
    appDisable: store.appDisable,
    online: store.online,

    user: store.user,
    setUser: store.patchUser,
    token: store.token,
    clientId,

    route: store.route,
    navigate: store.navigate,
    selected,
    conversations: store.conversations,
    convGroups,
    convDms,
    articleSidebar: store.articleSidebar,
    articleListRevision,

    loginLoading: store.loginLoading,
    loginError: store.loginError,
    oobe: store.oobe,
    setOobe: store.setOobe,
    oobeHandle: store.oobeHandle,
    setOobeHandle: (h: string) => store.patchOobeFields({ handle: h }),
    oobeUsername: store.oobeUsername,
    setOobeUsername: (n: string) => store.patchOobeFields({ username: n }),

    handleLoginPin,
    handleOobePin,
    handleOobeSubmit,
    handleLogout,
    handleNewDm,
    handleConversationUpdate,
    handleLeftGroup,
    subscribePostEvents: postEvents.subscribe,
    subscribeConfigEvents: configEvents.subscribe,

    lockKonami,
    unlockKonami,
  };
}
