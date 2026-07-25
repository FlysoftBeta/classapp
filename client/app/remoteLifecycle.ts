import { probeAppState } from "@/client/api/auth";
import { client } from "@/client/lib/remote/client";
import { session } from "@/client/lib/remote/session";
import {
  syncOfflineContent,
  syncPendingMutations,
} from "@/client/resource/offlineSync";
import { offlineSession } from "@/client/resource/offlineSession";
import { useAppStore } from "@/client/app/appStore";
import type { EventData } from "@/shared/protocol/events";
import { USER_CONFIG } from "@/shared/userConfig/keys";
import type {
  AppStatePayload,
  UserConfigChangedEvent,
} from "@/client/app/appReducer";
import type { ConvUpdatedPayload } from "@/shared/types/events";
import {
  refreshArticleSidebar,
  refreshConversations,
  scheduleArticleRefresh,
  scheduleConversationRefresh,
} from "./resources";
import { announcementEvents, configEvents, postEvents } from "./events";

type RemoteCallbacks = {
  onArticleListUpdated: () => void;
};

let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
let recoveryRun: Promise<void> | null = null;

async function refreshState(touch = true): Promise<void> {
  const payload = await probeAppState(touch ? undefined : { touch: false });
  if (payload) applyAppState(payload);
}

function recover(): void {
  if (recoveryTimer) clearTimeout(recoveryTimer);
  recoveryTimer = setTimeout(() => {
    recoveryTimer = null;
    if (recoveryRun) return;
    const run = (async () => {
      await refreshState().catch(() => {});
      if (session.getToken()) {
        await syncOfflineContent();
        await Promise.all([refreshConversations(), refreshArticleSidebar()]);
      }
      useAppStore.getState().dispatch({ type: "REMOTE_RESUBSCRIBE" });
    })().finally(() => {
      if (recoveryRun === run) recoveryRun = null;
    });
    recoveryRun = run;
  }, 150);
}

export function bindRemoteLifecycle(callbacks: RemoteCallbacks): () => void {
  const dispatch = useAppStore.getState().dispatch;
  const onMuted = (data: EventData<"user.muted_changed">) => {
    const user = useAppStore.getState().user;
    if (!user) {
      void refreshState();
      return;
    }
    dispatch({
      type: "PATCH_USER",
      user: {
        ...user,
        is_muted: data.is_muted,
        muted_until: data.muted_until,
      },
    });
  };
  const onConfig = (data: UserConfigChangedEvent) => {
    if (data.key === USER_CONFIG.ACTIVE_ARTICLE_ID) {
      dispatch({
        type: "PATCH_ARTICLE_SIDEBAR_CURRENT",
        currentArticleId: data.value,
      });
    }
    configEvents.emit(data);
  };
  const onConversationUpdated = (data: ConvUpdatedPayload) => {
    // The server already sends the authoritative sidebar row. Apply it before
    // any follow-up fetch so a post banner and its unread indicator advance in
    // the same event turn.
    dispatch({ type: "CONV_PAYLOAD", payload: data });
    // Keep the existing reconciled fetch path for pending offline read/config
    // mutations and persistence; it no longer blocks the visible update.
    scheduleConversationRefresh();
  };

  const unsubscribers = [
    client.subscribe("client.lock_changed", () => void refreshState()),
    client.subscribe("client.idle_locked", () => void refreshState(false)),
    client.subscribe("client.deleted", () => {
      void offlineSession.clear();
      session.setToken("");
      dispatch({ type: "LOGOUT" });
      dispatch({ type: "SET_APP_STATE", appState: "login" });
    }),
    client.subscribe("user.banned", () => void refreshState()),
    client.subscribe("user.unbanned", () => void refreshState()),
    client.subscribe("user.muted_changed", onMuted),
    client.subscribe("user.profile_changed", (data) =>
      dispatch({ type: "PATCH_USER", user: data.user }),
    ),
    client.subscribe("system.lock_changed", () => void refreshState()),
    client.subscribe("system.announcement_changed", announcementEvents.emit),
    client.subscribe("remote.resubscribe", () =>
      dispatch({ type: "REMOTE_RESUBSCRIBE" }),
    ),
    client.subscribe("conv.updated", onConversationUpdated),
    client.subscribe("post.created", (data) =>
      postEvents.emit({ kind: "post.created", data }),
    ),
    client.subscribe("post.updated", (data) =>
      postEvents.emit({ kind: "post.updated", data }),
    ),
    client.subscribe("post.deleted", (data) =>
      postEvents.emit({ kind: "post.deleted", data }),
    ),
    client.subscribe("article.sidebar_updated", scheduleArticleRefresh),
    client.subscribe("article.list_updated", callbacks.onArticleListUpdated),
    client.subscribe("user.config_changed", onConfig),
  ];

  dispatch({ type: "SET_ONLINE", online: client.isConnected() });
  const offConnection = client.onConnectionChange((connected) => {
    dispatch({ type: "SET_ONLINE", online: connected });
    if (connected) recover();
  });

  return () => {
    if (recoveryTimer) {
      clearTimeout(recoveryTimer);
      recoveryTimer = null;
    }
    offConnection();
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}

export function startHeartbeat(): () => void {
  const tick = () => {
    const { appState, token } = useAppStore.getState();
    if (appState !== "app" || !token) return;
    void refreshState();
    void syncPendingMutations().catch(() => {});
  };
  const timer = setInterval(tick, 120_000);
  return () => clearInterval(timer);
}

export function applyAppState(payload: AppStatePayload): void {
  if (payload.reason === "session_expired" || payload.client_invalid) {
    session.setToken("");
    void offlineSession.clear();
  }
  useAppStore.getState().dispatch({ type: "APPLY_STATE", payload });
}
