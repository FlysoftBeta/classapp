import { expectBoolean, withActionScope } from "./_base";
import type { ActionInput } from "@/shared/protocol/actions";

export async function fetchNotificationConfigAction() {
  return withActionScope(async (scope) => {
    return scope.facades().notificationConfig().get();
  });
}

export async function updateDoNotDisturbAction(
  input: ActionInput<"updateDoNotDisturbAction">,
) {
  return withActionScope(async (scope) => {
    return scope
      .facades()
      .notificationConfig()
      .setDoNotDisturb(expectBoolean(input.enabled, "enabled 必须为布尔值"));
  });
}
