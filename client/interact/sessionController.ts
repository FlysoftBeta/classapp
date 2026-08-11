import {
  autoLogin,
  completeOobe,
  getClientMe,
  loginPin,
  logout as apiLogout,
  patchClientMe,
  probeAppState,
} from "@/client/api/auth";
import { sessionRepository } from "@/client/data/repository";
import type { AppStatePayload } from "@/shared/types/events";
import { useApplicationStore } from "./appStore";
import { applyAppState } from "./remoteLifecycle";
import { resourceQueries } from "./resources";
import { session } from "./remote/session";
import { transport } from "./remote/transport";
import { captureDetachedClientIncident } from "./clientIncidents";

function commitSession(token: string, user: AppStatePayload["user"]): void {
  if (!user) return;
  session.bind(user.id, token);
  useApplicationStore.getState().setSession(token, user);
  void sessionRepository.save(user, token);
}

async function refreshInitialData(): Promise<void> {
  await Promise.all([
    resourceQueries.refreshConversations(),
    resourceQueries.refreshArticleSidebar(),
  ]);
}

/** Warm-start locally, then let the server authoritatively choose the gate. */
export async function bootstrapSession(
  setClientId: (clientId: string) => void,
): Promise<void> {
  let restored = await sessionRepository.active().catch((error) => {
    captureDetachedClientIncident("session.restore", error);
    return null;
  });
  let knownKonamiLocked: boolean | null = null;
  if (restored?.session_token) {
    commitSession(restored.session_token, restored.user);
    useApplicationStore.getState().setAppState("app");
    await refreshInitialData();
  }

  try {
    if (!transport.isConnected()) {
      const connection = transport.waitUntilConnected();
      const connectedQuickly = await Promise.race([
        connection.then(() => true),
        new Promise<false>((resolve) =>
          setTimeout(() => resolve(false), 5_000),
        ),
      ]);
      if (!connectedQuickly) {
        if (!restored) useApplicationStore.getState().setAppState("login");
        // Keep the bootstrap coroutine alive: a later retry still performs the
        // authoritative gate and device auto-login without a page reload.
        await connection;
      }
    }
    const me = await getClientMe();
    if (me.res.ok && "client_id" in me.data) {
      setClientId(me.data.client_id ?? "");
    }
    const automatic = await autoLogin();
    knownKonamiLocked = automatic.konami_locked;
    if (automatic.banned) {
      await clearLocalSession();
      const store = useApplicationStore.getState();
      store.setAppDisable({
        disabled: true,
        reason: "banned",
        banned_until: automatic.banned_until,
        username: automatic.username,
      });
      store.setAppState("app_locked");
      return;
    }
    if (automatic.user && automatic.token) {
      restored = {
        me_id: automatic.user.id,
        user: automatic.user,
        session_token: automatic.token,
        updated_at: Date.now(),
      };
      commitSession(automatic.token, automatic.user);
      await refreshInitialData();
    }
    const payload = await probeAppState();
    if (payload) applyAppState(payload);
    else if (!restored) {
      useApplicationStore
        .getState()
        .setAppState(automatic.konami_locked ? "konami" : "login");
    }
  } catch (error) {
    captureDetachedClientIncident("session.bootstrap", error);
    if (!restored) {
      useApplicationStore
        .getState()
        .setAppState(knownKonamiLocked === true ? "konami" : "login");
    }
  }
}

async function clearLocalSession(): Promise<void> {
  session.clearActive();
  await sessionRepository.clear();
  useApplicationStore.getState().clearSession();
}

export async function lockSession(): Promise<void> {
  await patchClientMe(true);
  useApplicationStore.getState().setAppState("konami");
}

export async function unlockSession(
  setClientId: (clientId: string) => void,
): Promise<string | null> {
  try {
    const result = await patchClientMe(false);
    if (result.ok && !result.data.ok && "access_required" in result.data) {
      setClientId(result.data.client_id);
      return result.data.client_id;
    }
  } catch (error) {
    captureDetachedClientIncident("session.unlock", error);
    return "";
  }
  const payload = await probeAppState();
  if (payload) applyAppState(payload);
  else {
    useApplicationStore
      .getState()
      .setAppState(session.getToken() ? "app" : "login");
  }
  return null;
}

export async function loginWithPin(pin: string): Promise<void> {
  const store = useApplicationStore.getState();
  store.setLoginError("");
  store.setLoginLoading(true);
  try {
    const { data: raw } = await loginPin(pin);
    const data = raw as Record<string, unknown>;
    if (data.banned) {
      store.setAppDisable({
        disabled: true,
        reason: "banned",
        banned_until: data.banned_until as string,
        username: data.username as string,
      });
      store.setAppState("app_locked");
      return;
    }
    if ("error" in data) {
      store.setLoginError(
        (typeof data.error === "string" && data.error) ||
          "PIN 错误，请重试；如需帮助请联系管理员。",
      );
      return;
    }
    if (data.needs_oobe) {
      store.setOobe({
        oobe_token: data.oobe_token as string,
        pin1: "",
        pin2: "",
        step: "pin1",
        error: "",
        submitting: false,
      });
      store.patchOobeFields({ handle: "", username: "" });
      store.setAppState("oobe");
      return;
    }
    commitSession(data.token as string, data.user as AppStatePayload["user"]);
    await refreshInitialData();
    const payload = await probeAppState();
    if (payload) applyAppState(payload);
    else store.setAppState("app");
  } catch (error) {
    captureDetachedClientIncident("session.login", error);
    store.setLoginError(
      error instanceof Error
        ? error.message
        : "无法连接服务器，请检查网络后重试。",
    );
  } finally {
    useApplicationStore.getState().setLoginLoading(false);
  }
}

export function acceptOobePin(pin: string): void {
  const store = useApplicationStore.getState();
  const oobe = store.oobe;
  if (!oobe) return;
  if (oobe.step === "pin1") {
    store.setOobe({ ...oobe, pin1: pin, step: "pin2_prompt", error: "" });
  } else if (oobe.step === "pin2") {
    store.setOobe({ ...oobe, pin2: pin, step: "handle", error: "" });
  }
}

export async function submitOobe(): Promise<void> {
  const state = useApplicationStore.getState();
  if (!state.oobe) return;
  const original = state.oobe;
  state.setOobe({ ...original, submitting: true, error: "" });
  try {
    const { data } = await completeOobe({
      oobe_token: original.oobe_token,
      handle: state.oobeHandle.trim(),
      username: state.oobeUsername.trim(),
      new_pins: original.pin2
        ? [original.pin1, original.pin2]
        : [original.pin1],
    });
    if ("error" in data) {
      state.setOobe({
        ...original,
        submitting: false,
        error: ("error" in data ? data.error : undefined) || "设置失败",
      });
      return;
    }
    commitSession(data.token, data.user);
    await refreshInitialData();
    state.setOobe(null);
    const payload = await probeAppState();
    if (payload) applyAppState(payload);
    else state.setAppState("app");
  } catch (error) {
    captureDetachedClientIncident("session.oobe", error);
    const current = useApplicationStore.getState().oobe;
    useApplicationStore.getState().setOobe(
      current
        ? {
            ...current,
            submitting: false,
            error: error instanceof Error ? error.message : "网络错误",
          }
        : null,
    );
  }
}

export async function logoutSession(): Promise<void> {
  let remoteFailed = false;
  let remoteError: unknown;
  try {
    await apiLogout();
  } catch (error) {
    remoteFailed = true;
    remoteError = error;
  }
  try {
    await clearLocalSession();
  } catch (cleanupError) {
    if (!remoteFailed) throw cleanupError;
    // Local cleanup is best-effort after a remote panic; preserve the remote
    // Incident while reporting the independent cleanup failure.
    captureDetachedClientIncident("session.logout-cleanup", cleanupError);
  }
  if (remoteFailed) throw remoteError;
  const payload = await probeAppState();
  if (payload) applyAppState(payload);
  else useApplicationStore.getState().setAppState("login");
}

export { clearLocalSession };
