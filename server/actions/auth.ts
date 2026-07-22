import { createAuthService } from "@/server/services/authService";
import { withActionSession, expectString } from "./_base";
import { actionClientIdentity } from "@/server/session/session";
import { getDb } from "@/server/infra/db";
import type { ActionInput } from "@/shared/protocol/actions";

export async function autoLoginAction() {
  return withActionSession(async () => {
    return createAuthService(getDb(), actionClientIdentity()).autoLogin();
  });
}

export async function loginPinAction(pin: ActionInput<"loginPinAction">) {
  return withActionSession(async () => {
    return createAuthService(getDb(), actionClientIdentity()).login(
      expectString(pin, "PIN 格式错误"),
    );
  });
}

export async function completeOobeAction(
  input: ActionInput<"completeOobeAction">,
) {
  return withActionSession(async () => {
    return createAuthService(getDb(), actionClientIdentity()).completeOobe(
      input,
    );
  });
}

export async function logoutAction() {
  return withActionSession(async (session) => {
    const token = session.tokenValue();
    if (token) {
      createAuthService(getDb(), actionClientIdentity()).logout(token);
    }
    return { ok: true as const };
  });
}

export async function updateMeAction(input: ActionInput<"updateMeAction">) {
  return withActionSession(async (session) => {
    const users = await (await session.asActor()).users();
    if (input.resetPins) {
      await users.resetSelfPin(input.resetPins);
      return { ok: true as const };
    }
    return {
      user: await users.updateSelf({
        handle: input.handle,
        username: input.username,
      }),
    };
  });
}
