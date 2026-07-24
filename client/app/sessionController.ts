import {
  autoLogin,
  completeOobe,
  getClientMe,
  loginPin,
  logout as apiLogout,
  patchClientMe,
  probeAppState,
} from "@/client/api/auth";
import type { AppStatePayload } from "@/client/app/appReducer";
import { session } from "@/client/lib/remote/session";
import { offlineRepository } from "@/client/resource/offlineRepository";
import {
  offlineSession,
  type OfflineSession,
} from "@/client/resource/offlineSession";
import { useAppStore } from "@/client/app/appStore";
import { refreshArticleSidebar, refreshConversations } from "./resources";
import { applyAppState } from "./remoteLifecycle";

const dispatch = (
  action: Parameters<ReturnType<typeof useAppStore.getState>["dispatch"]>[0],
) => useAppStore.getState().dispatch(action);

function commitSession(token: string, user: AppStatePayload["user"]): void {
  if (!user) return;
  session.setToken(token);
  offlineRepository.setUserScope(user.id);
  dispatch({ type: "SET_TOKEN", token, user });
}

async function refreshInitialData(): Promise<void> {
  await Promise.all([refreshConversations(), refreshArticleSidebar()]);
}

export async function bootstrapSession(
  setClientId: (clientId: string) => void,
): Promise<void> {
  let cachedSession: OfflineSession | null = null;
  try {
    cachedSession = await offlineSession.get();
    if (cachedSession) {
      commitSession(cachedSession.token, cachedSession.user);
      dispatch({ type: "SET_APP_STATE", appState: "app" });
      await refreshInitialData();
    }

    const me = await getClientMe();
    if (me.res.ok && "client_id" in me.data) {
      setClientId(me.data.client_id ?? "");
    }
    const auto = await autoLogin();
    if (auto.banned) {
      await offlineSession.clear();
      session.setToken("");
      dispatch({ type: "LOGOUT" });
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
      cachedSession = { user: auto.user, token: auto.token };
      commitSession(auto.token, auto.user);
      await refreshInitialData();
    }

    const payload = await probeAppState();
    if (payload) applyAppState(payload);
    else if (!cachedSession) {
      dispatch({
        type: "SET_APP_STATE",
        appState: auto.konami_locked ? "konami" : "login",
      });
    }
  } catch {
    if (!cachedSession) {
      dispatch({ type: "SET_APP_STATE", appState: "login" });
    }
  }
}

export async function lockSession(): Promise<void> {
  try {
    await patchClientMe(true);
  } catch {
    // The local lock remains effective without the server.
  }
  dispatch({ type: "SET_APP_STATE", appState: "konami" });
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
  } catch {
    return "";
  }
  const payload = await probeAppState();
  if (payload) applyAppState(payload);
  else {
    dispatch({
      type: "SET_APP_STATE",
      appState: session.getToken() ? "app" : "login",
    });
  }
  return null;
}

export async function loginWithPin(pin: string): Promise<void> {
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

    commitSession(data.token as string, data.user as AppStatePayload["user"]);
    await refreshInitialData();
    const payload = await probeAppState();
    if (payload) applyAppState(payload);
    else dispatch({ type: "SET_APP_STATE", appState: "app" });
  } catch {
    dispatch({
      type: "SET_LOGIN_ERROR",
      error: "无法连接服务器，请检查网络后重试。",
    });
  } finally {
    dispatch({ type: "SET_LOGIN_LOADING", loading: false });
  }
}

export function acceptOobePin(pin: string): void {
  const { oobe } = useAppStore.getState();
  if (!oobe) return;
  if (oobe.step === "pin1") {
    dispatch({
      type: "SET_OOBE",
      oobe: { ...oobe, pin1: pin, step: "pin2_prompt", error: "" },
    });
  } else if (oobe.step === "pin2") {
    dispatch({
      type: "SET_OOBE",
      oobe: { ...oobe, pin2: pin, step: "handle", error: "" },
    });
  }
}

export async function submitOobe(): Promise<void> {
  const state = useAppStore.getState();
  if (!state.oobe) return;
  const oobe = state.oobe;
  dispatch({
    type: "SET_OOBE",
    oobe: { ...oobe, submitting: true, error: "" },
  });
  try {
    const { res, data } = await completeOobe({
      oobe_token: oobe.oobe_token,
      handle: state.oobeHandle.trim(),
      username: state.oobeUsername.trim(),
      new_pins: oobe.pin2 ? [oobe.pin1, oobe.pin2] : [oobe.pin1],
    });
    if (!res.ok || "error" in data) {
      dispatch({
        type: "SET_OOBE",
        oobe: {
          ...oobe,
          submitting: false,
          error: ("error" in data ? data.error : undefined) || "设置失败",
        },
      });
      return;
    }
    commitSession(data.token, data.user);
    await refreshInitialData();
    dispatch({ type: "SET_OOBE", oobe: null });
    const payload = await probeAppState();
    if (payload) applyAppState(payload);
    else dispatch({ type: "SET_APP_STATE", appState: "app" });
  } catch {
    const current = useAppStore.getState().oobe;
    dispatch({
      type: "SET_OOBE",
      oobe: current
        ? { ...current, submitting: false, error: "网络错误" }
        : null,
    });
  }
}

export async function logoutSession(): Promise<void> {
  try {
    await apiLogout();
  } catch {
    // Local logout must still complete.
  }
  await offlineSession.clear();
  session.setToken("");
  dispatch({ type: "LOGOUT" });
  const payload = await probeAppState();
  if (payload) applyAppState(payload);
  else dispatch({ type: "SET_APP_STATE", appState: "login" });
}
