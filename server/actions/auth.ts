import { withActionScope, expectString } from "./_base";
import type { ActionInput } from "@/shared/protocol/actions";

export async function autoLoginAction() {
  return withActionScope(async (scope) => {
    return scope.facades().authentication().autoLogin();
  });
}

export async function loginPinAction(pin: ActionInput<"loginPinAction">) {
  return withActionScope(async (scope) => {
    return scope
      .facades()
      .authentication()
      .login(expectString(pin, "PIN 格式错误"));
  });
}

export async function completeOobeAction(
  input: ActionInput<"completeOobeAction">,
) {
  return withActionScope(async (scope) => {
    return scope.facades().authentication().completeOobe(input);
  });
}

export async function logoutAction() {
  return withActionScope(async (scope) => {
    return scope.facades().authentication().logout(scope.identity.token);
  });
}

export async function updateMeAction(input: ActionInput<"updateMeAction">) {
  return withActionScope(async (scope) => {
    const users = scope.facades().users();
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
