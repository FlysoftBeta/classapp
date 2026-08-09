import type { User } from "@/shared/types/api";
import type { ActionArgs, ActionData } from "@/shared/protocol/actions";
import { observeActionResult } from "./runtime";
import type { AppStatePayload } from "@/shared/types/events";
import { client } from "@/client/interact/remote/client";

const {
  autoLoginAction,
  completeOobeAction,
  loginPinAction,
  logoutAction,
  updateMeAction,
  getClientMeAction,
  patchClientMeAction,
  probeAppStateAction,
} = client.actions;

export type UpdateMeData = {
  user?: User;
  ok?: true;
  error?: string;
};

export type ClientMeData = {
  client_id?: string;
  ip?: string;
  client_invalid?: boolean;
  error?: string;
};

export async function updateMe(body: ActionArgs<"updateMeAction">[0]) {
  const result = await updateMeAction(body);
  const res = observeActionResult(result);
  const data: UpdateMeData = result.ok
    ? result.data
    : { error: result.error.message };
  return { res, data };
}

export async function probeAppState(opts?: {
  touch?: boolean;
}): Promise<AppStatePayload | null> {
  const result =
    opts === undefined
      ? await probeAppStateAction()
      : await probeAppStateAction(opts);
  const res = observeActionResult(result);
  if (!res.ok) return null;
  return result.ok ? result.data : null;
}

export async function autoLogin(): Promise<ActionData<"autoLoginAction">> {
  const result = await autoLoginAction();
  observeActionResult(result);
  if (result.ok) {
    return result.data;
  }
  return {
    user: null,
    konami_locked: true,
  };
}

export async function loginPin(pin: string) {
  const result = await loginPinAction(pin);
  const res = observeActionResult(result);
  return {
    res,
    data: result.ok ? result.data : { error: result.error.message },
  };
}

export async function completeOobe(body: {
  oobe_token: string;
  handle: string;
  username: string;
  new_pins: string[];
}) {
  const result = await completeOobeAction(body);
  const res = observeActionResult(result);
  return {
    res,
    data: result.ok ? result.data : { error: result.error.message },
  };
}

export async function logout() {
  return observeActionResult(await logoutAction());
}

export async function getClientMe() {
  const result = await getClientMeAction();
  const res = observeActionResult(result);
  return {
    res,
    data: result.ok ? result.data : { error: result.error.message },
  };
}

export async function patchClientMe(konami_locked: boolean) {
  const result = await patchClientMeAction(konami_locked);
  observeActionResult(result);
  return result;
}
