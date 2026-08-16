import { probeAppState } from "@/client/api/auth";
import { sessionRepository } from "@/client/data/repository";
import {
  captureActorContext,
  isActorContextCurrent,
  repositoryForActor,
} from "@/client/interact/actorContext";
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
import {
  aiRunEvents,
  announcementEvents,
  configEvents,
  postEvents,
} from "./events";
import {
  applyMediaMaterializationEvent,
  refreshMediaPlaylists,
  refreshMediaQueue,
  resetMediaPresentation,
} from "./media";
import {
  mediaConfigEvents,
  mediaMaterializationEvents,
  mediaPlaylistEvents,
  mediaQueueEvents,
  mediaTrackEvents,
} from "./mediaEvents";
import { useMediaStore } from "./mediaStore";
import { resourceQueries } from "./resources";
import { client } from "./remote/client";
import { session } from "./remote/session";
import { captureDetachedClientIncident } from "./clientIncidents";
import { materializePost } from "./posts";
import { flushPendingClientLock } from "./clientLock";

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
        .catch((error) => {
          captureDetachedClientIncident("recovery.event", error);
          this.schedule();
        });
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
    const continueAfter = async (
      label: string,
      operation: Promise<unknown>,
    ) => {
      try {
        await operation;
      } catch (error) {
        captureDetachedClientIncident(label, error);
      }
    };
    await continueAfter("recovery.app-state", refreshState());
    if (!session.getToken()) {
      this.queuedEvents = [];
      this.phase = "idle";
      return;
    }

    // Refresh access first. Proposals for no-longer-accessible objects stay
    // dormant locally and are excluded from flush until access returns.
    this.phase = "refreshing-access";
    await continueAfter(
      "recovery.conversation-access",
      resourceQueries.refreshConversationAccess(),
    );

    this.phase = "flushing-proposals";
    await continueAfter("recovery.pending-mutations", syncPendingMutations());

    this.phase = "recovering-revisions";
    await continueAfter(
      "recovery.post-revisions",
      syncConversationPostRevisions(),
    );

    this.phase = "refreshing-snapshots";
    await Promise.all([
      continueAfter(
        "recovery.article-sidebar",
        resourceQueries.refreshArticleSidebar(),
      ),
      continueAfter("recovery.ai-sidebar", resourceQueries.refreshAiSidebar()),
      continueAfter("recovery.offline-content", syncOfflineContent()),
    ]);

    this.phase = "replaying-events";
    while (this.queuedEvents.length) {
      const batch = this.queuedEvents.splice(0);
      for (const event of batch) {
        await Promise.resolve()
          .then(event)
          .catch((error) =>
            captureDetachedClientIncident("recovery.replayed-event", error),
          );
      }
    }
    this.phase = "idle";
  }
}

const recovery = new RecoveryCoordinator();
let invalidRecovery: Promise<void> | null = null;

async function refreshState(touch = true): Promise<void> {
  await flushPendingClientLock();
  const payload = await probeAppState(touch ? undefined : { touch: false });
  if (payload) await applyAppState(payload);
}

export function recoverInvalidSession(): void {
  session.clearActive();
  void sessionRepository.clear();
  const store = useApplicationStore.getState();
  store.clearSession();
  store.setAppState("loading");
  if (invalidRecovery) return;
  const run = refreshState()
    .catch((error) => {
      captureDetachedClientIncident("session.invalid-recovery", error);
    })
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

  const onConfig = (data: EventData<"user.config_changed">) => {
    const actor = captureActorContext();
    const repository = repositoryForActor(actor);
    recovery.enqueue(async () => {
      if (!isActorContextCurrent(actor)) return;
      const winner = await reconcileUserSettingEvent(data, repository);
      if (winner.key === USER_CONFIG.ACTIVE_ARTICLE_ID) {
        useApplicationStore.getState().setCurrentArticle(winner.value);
      }
      configEvents.emit(winner);
    });
  };

  const onConversation = (data: ConvUpdatedPayload) => {
    const actor = captureActorContext();
    const repository = repositoryForActor(actor);
    recovery.enqueue(async () => {
      if (!isActorContextCurrent(actor)) return;
      if (data.entry) {
        await repository.upsertConversation(data.entry, data.users ?? []);
        const entry = (await repository.getConversations()).find(
          (candidate) =>
            candidate.type === data.entry!.type &&
            candidate.id === data.entry!.id,
        );
        if (entry) {
          useApplicationStore.getState().applyConversation({ entry });
        }
      }
      if (data.removed) {
        useApplicationStore.getState().applyConversation({
          removed: data.removed,
        });
        await repository.removeConversation(data.removed);
      }
      if (data.refresh) resourceQueries.scheduleConversations();
    });
  };

  const onPost = (
    kind: "post.created" | "post.updated" | "post.deleted",
    data: EventData<typeof kind>,
  ) => {
    const actor = captureActorContext();
    const repository = repositoryForActor(actor);
    recovery.enqueue(async () => {
      if (!isActorContextCurrent(actor)) return;
      await repository.saveUserMetadata(data.users);
      await repository.applyPostVersion(data.post, kind === "post.created");
      postEvents.emit({
        kind,
        data: { ...data, post: materializePost(data.post, data.users) },
      });
    });
  };

  const unsubscribers = [
    client.subscribe("client.lock_changed", () => void refreshState()),
    client.subscribe("client.idle_locked", () => void refreshState(false)),
    client.subscribe("client.deleted", recoverInvalidSession),
    client.subscribe("user.banned", () => void refreshState()),
    client.subscribe("user.unbanned", () => void refreshState()),
    client.subscribe("user.muted_changed", onMuted),
    client.subscribe("user.profile_changed", ({ user }) => {
      useApplicationStore.getState().patchUser(user);
      const actor = captureActorContext();
      recovery.enqueue(async () => {
        if (!isActorContextCurrent(actor)) return;
        await repositoryForActor(actor).saveUserMetadata([
          {
            id: user.id,
            revision: user.profile_revision,
            handle: user.handle,
            username: user.username,
          },
        ]);
      });
    }),
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
    client.subscribe("ai.run.updated", (data) => {
      recovery.enqueue(() => {
        useApplicationStore.getState().applyAiRun(data);
        aiRunEvents.emit(data);
      });
    }),
    client.subscribe("ai.sidebar.updated", () =>
      resourceQueries.scheduleAiSidebar(),
    ),
    client.subscribe("media.track.changed", (data) => {
      mediaTrackEvents.emit(data);
    }),
    client.subscribe("media.playlist.changed", (data) => {
      mediaPlaylistEvents.emit(data);
      void refreshMediaPlaylists();
    }),
    client.subscribe("media.queue.changed", (data) => {
      mediaQueueEvents.emit(data);
      void refreshMediaQueue();
    }),
    client.subscribe("media.config.changed", (data) => {
      useMediaStore.getState().setConfig(data);
      mediaConfigEvents.emit(data);
    }),
    client.subscribe("media.materialization.changed", (data) => {
      applyMediaMaterializationEvent(data);
      mediaMaterializationEvents.emit(data);
    }),
  ];

  useApplicationStore.getState().setOnline(client.isConnected());
  const offToken = session.onTokenChange(() => {
    recovery.stop();
    resourceQueries.invalidate();
    resetMediaPresentation();
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
    void syncPendingMutations().catch((error) =>
      captureDetachedClientIncident("heartbeat.pending-mutations", error),
    );
  }, 120_000);
  return () => clearInterval(timer);
}

export async function applyAppState(payload: AppStatePayload): Promise<void> {
  if (payload.client_invalid) {
    session.clearActive();
    await sessionRepository
      .clear()
      .catch((error) =>
        captureDetachedClientIncident("app-state.clear-invalid", error),
      );
  }
  const cached = await sessionRepository.active().catch((error) => {
    captureDetachedClientIncident("app-state.read-local", error);
    return null;
  });
  const cachedProposal = cached?.konami_lock.proposal ?? null;
  const localProposal =
    !payload.client_invalid &&
    payload.user?.id === cached?.me_id &&
    cachedProposal
      ? cachedProposal.value
      : null;
  const effectivePayload =
    localProposal === null
      ? payload
      : { ...payload, konami_locked: localProposal };
  const store = useApplicationStore.getState();
  store.applyServerState(effectivePayload);
  const applied = useApplicationStore.getState();
  if (
    payload.session_valid &&
    payload.user &&
    applied.user?.id === payload.user.id &&
    applied.token
  ) {
    void sessionRepository
      .saveServerState(payload.user, {
        konami_locked: payload.konami_locked,
        app_disable: payload.app,
        system_locked: payload.flags.system_locked,
      })
      .catch((error) =>
        captureDetachedClientIncident("app-state.persist", error),
      );
  }
}
