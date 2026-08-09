import { probeAppState } from "@/client/api/auth";
import { offlineRepository, sessionRepository } from "@/client/data/repository";
import {
  syncOfflineContent,
  syncPendingMutations,
} from "@/client/interact/sync";
import { reconcileUserSettingEvent } from "@/client/interact/versionedSettings";
import { syncConversationPostRevisions } from "@/client/interact/conversations";
import type { EventData } from "@/shared/protocol/events";
import type {
  AppStatePayload,
  ConvUpdatedPayload,
} from "@/shared/types/events";
import { USER_CONFIG } from "@/shared/userConfig/keys";
import { useApplicationStore } from "./appStore";
import { announcementEvents, configEvents, postEvents } from "./events";
import { resourceQueries } from "./resources";
import { client } from "./remote/client";
import { session } from "./remote/session";

type RemoteCallbacks = {
  onArticleListUpdated: () => void;
};

type RecoveryPhase =
  | "idle"
  | "refreshing-access"
  | "flushing-proposals"
  | "recovering-revisions"
  | "refreshing-snapshots"
  | "replaying-events";

class RecoveryCoordinator {
  private phase: RecoveryPhase = "idle";
  private queuedEvents: Array<() => void | Promise<void>> = [];
  private scheduled: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;

  enqueue(event: () => void | Promise<void>): void {
    if (this.phase === "idle") {
      void Promise.resolve()
        .then(event)
        .catch(() => this.schedule());
      return;
    }
    this.queuedEvents.push(event);
  }

  schedule(): void {
    if (this.phase === "idle") this.phase = "refreshing-access";
    if (this.scheduled) clearTimeout(this.scheduled);
    this.scheduled = setTimeout(() => {
      this.scheduled = null;
      void this.recover();
    }, 150);
  }

  stop(): void {
    if (this.scheduled) clearTimeout(this.scheduled);
    this.scheduled = null;
    this.queuedEvents = [];
    this.phase = "idle";
  }

  private async recover(): Promise<void> {
    if (this.running) return this.running;
    const run = this.run().finally(() => {
      if (this.running === run) this.running = null;
    });
    this.running = run;
    return run;
  }

  private async run(): Promise<void> {
    await refreshState().catch(() => undefined);
    if (!session.getToken()) {
      this.queuedEvents = [];
      this.phase = "idle";
      return;
    }

    // Refresh access first. Proposals for no-longer-accessible objects stay
    // dormant locally and are excluded from flush until access returns.
    this.phase = "refreshing-access";
    await resourceQueries.refreshConversationAccess().catch(() => undefined);

    this.phase = "flushing-proposals";
    await syncPendingMutations().catch(() => undefined);

    this.phase = "recovering-revisions";
    await syncConversationPostRevisions().catch(() => undefined);

    this.phase = "refreshing-snapshots";
    await Promise.all([
      resourceQueries.refreshArticleSidebar().catch(() => undefined),
      syncOfflineContent().catch(() => undefined),
    ]);

    this.phase = "replaying-events";
    while (this.queuedEvents.length) {
      const batch = this.queuedEvents.splice(0);
      for (const event of batch) {
        await Promise.resolve()
          .then(event)
          .catch(() => undefined);
      }
    }
    this.phase = "idle";
  }
}

const recovery = new RecoveryCoordinator();
let invalidRecovery: Promise<void> | null = null;

async function refreshState(touch = true): Promise<void> {
  const payload = await probeAppState(touch ? undefined : { touch: false });
  if (payload) applyAppState(payload);
}

export function recoverInvalidSession(): void {
  session.setToken("");
  offlineRepository.setUserScope(null);
  void sessionRepository.clear();
  const store = useApplicationStore.getState();
  store.clearSession();
  store.setAppState("loading");
  if (invalidRecovery) return;
  const run = refreshState()
    .catch(() => undefined)
    .finally(() => {
      if (invalidRecovery === run) invalidRecovery = null;
    });
  invalidRecovery = run;
}

export function bindInvalidSessionHandler(): () => void {
  session.setInvalidHandler(recoverInvalidSession);
  return () => session.setInvalidHandler(null);
}

export function bindRemoteLifecycle(callbacks: RemoteCallbacks): () => void {
  const onMuted = (data: EventData<"user.muted_changed">) => {
    const state = useApplicationStore.getState();
    if (!state.user) {
      void refreshState();
      return;
    }
    state.patchUser({
      ...state.user,
      is_muted: data.is_muted,
      muted_until: data.muted_until,
    });
  };

  const onConfig = (data: EventData<"user.config_changed">) =>
    recovery.enqueue(async () => {
      const winner = await reconcileUserSettingEvent(data);
      if (winner.key === USER_CONFIG.ACTIVE_ARTICLE_ID) {
        useApplicationStore.getState().setCurrentArticle(winner.value);
      }
      configEvents.emit(winner);
    });

  const onConversation = (data: ConvUpdatedPayload) =>
    recovery.enqueue(async () => {
      useApplicationStore.getState().applyConversation(data);
      if (data.entry) await offlineRepository.upsertConversation(data.entry);
      if (data.removed) {
        await offlineRepository.removeConversation(data.removed);
      }
      if (data.refresh) resourceQueries.scheduleConversations();
    });

  const onPost = (
    kind: "post.created" | "post.updated" | "post.deleted",
    data: EventData<typeof kind>,
  ) =>
    recovery.enqueue(async () => {
      await offlineRepository.applyPostVersion(
        data.post,
        kind === "post.created",
      );
      postEvents.emit({ kind, data });
    });

  const unsubscribers = [
    client.subscribe("client.lock_changed", () => void refreshState()),
    client.subscribe("client.idle_locked", () => void refreshState(false)),
    client.subscribe("client.deleted", recoverInvalidSession),
    client.subscribe("user.banned", () => void refreshState()),
    client.subscribe("user.unbanned", () => void refreshState()),
    client.subscribe("user.muted_changed", onMuted),
    client.subscribe("user.profile_changed", ({ user }) =>
      useApplicationStore.getState().patchUser(user),
    ),
    client.subscribe("system.lock_changed", () => void refreshState()),
    client.subscribe("system.announcement_changed", announcementEvents.emit),
    client.subscribe("remote.resubscribe", () => recovery.schedule()),
    client.subscribe("conv.updated", onConversation),
    client.subscribe("post.created", (data) => onPost("post.created", data)),
    client.subscribe("post.updated", (data) => onPost("post.updated", data)),
    client.subscribe("post.deleted", (data) => onPost("post.deleted", data)),
    client.subscribe("article.sidebar_updated", () =>
      resourceQueries.scheduleArticleSidebar(),
    ),
    client.subscribe("article.list_updated", callbacks.onArticleListUpdated),
    client.subscribe("user.config_changed", onConfig),
  ];

  useApplicationStore.getState().setOnline(client.isConnected());
  const offToken = session.onTokenChange(() => {
    recovery.stop();
    resourceQueries.invalidate();
  });
  const offConnection = client.onConnectionChange((connected) => {
    useApplicationStore.getState().setOnline(connected);
    if (connected) recovery.schedule();
  });

  return () => {
    recovery.stop();
    offToken();
    offConnection();
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}

export function startHeartbeat(): () => void {
  const timer = setInterval(() => {
    const state = useApplicationStore.getState();
    if (state.appState !== "app" || !state.token) return;
    void refreshState();
    void syncPendingMutations().catch(() => undefined);
  }, 120_000);
  return () => clearInterval(timer);
}

export function applyAppState(payload: AppStatePayload): void {
  if (payload.reason === "session_expired" || payload.client_invalid) {
    session.setToken("");
    offlineRepository.setUserScope(null);
    void sessionRepository.clear();
  }
  useApplicationStore.getState().applyServerState(payload);
}
