import { observeActionResult } from "./runtime";
import type { ActionData } from "@/shared/protocol/actions";
import { client } from "@/client/lib/remote/client";

const { fetchNotificationConfigAction, updateDoNotDisturbAction } =
  client.actions;

export async function fetchNotificationConfig(): Promise<
  ActionData<"fetchNotificationConfigAction">
> {
  const result = await fetchNotificationConfigAction();
  observeActionResult(result);
  return result.ok
    ? result.data
    : {
        doNotDisturb: false,
      };
}

export async function updateDoNotDisturb(enabled: boolean) {
  const result = await updateDoNotDisturbAction({ enabled });
  return observeActionResult(result);
}
