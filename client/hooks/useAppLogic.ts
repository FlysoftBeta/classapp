import { useEffect, useCallback, useRef, useMemo, useState } from "react";
import { session } from "@/client/lib/remote/session";
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
  type UserConfigChangedEvent,
} from "../app/appReducer";
import { useAppStore } from "@/client/app/appStore";
import { offlineRepository } from "@/client/data/repository";
import { offlineSession } from "@/client/resource/offlineSession";
import { scheduleConversationRefresh } from "@/client/app/resources";
import {
  bindRemoteLifecycle,
  recoverInvalidSession,
  startHeartbeat,
} from "@/client/app/remoteLifecycle";
import {
  acceptOobePin,
  bootstrapSession,
  lockSession,
  loginWithPin,
  logoutSession,
  submitOobe,
  unlockSession,
} from "@/client/app/sessionController";
import { configEvents, postEvents } from "@/client/app/events";

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

  const appStateRef = useRef<AppState>("loading");
  const selected = useMemo(
    () => deriveSelected(store.conversations, store.route),
    [store.conversations, store.route],
  );

  useEffect(() => {
    offlineRepository.setUserScope(store.user?.id ?? null);
  }, [store.user?.id]);

  useEffect(() => {
    if (!store.token || !store.user) return;
    void offlineSession.save({ token: store.token, user: store.user });
  }, [store.token, store.user]);

  useEffect(() => {
    appStateRef.current = store.appState;
  }, [store.appState]);

  // ── Client-invalid global handler ─────────────────────────────────────────
  useEffect(() => {
    session.setInvalidHandler(recoverInvalidSession);
    return () => session.setInvalidHandler(null);
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
      dispatch({ type: "NEW_DM", peerId, peerName });
    },
    [dispatch],
  );

  const handleConversationUpdate = useCallback(() => {
    scheduleConversationRefresh();
    dispatch({ type: "REMOTE_RESUBSCRIBE" });
  }, [dispatch]);

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
    subscribePostEvents: postEvents.subscribe,
    subscribeConfigEvents: configEvents.subscribe,

    lockKonami,
    unlockKonami,
  };
}
