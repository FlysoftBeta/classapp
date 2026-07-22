import { expectBoolean, withActionSession } from "./_base";
import type { ActionInput } from "@/shared/protocol/actions";

export async function fetchNotificationConfigAction() {
  return withActionSession(async (session) => {
    return (await (await session.asActor()).notificationConfig()).get();
  });
}

export async function updateDoNotDisturbAction(
  input: ActionInput<"updateDoNotDisturbAction">,
) {
  return withActionSession(async (session) => {
    return (
      await (await session.asActor()).notificationConfig()
    ).setDoNotDisturb(expectBoolean(input.enabled, "enabled 必须为布尔值"));
  });
}
