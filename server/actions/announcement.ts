import { withActionScope } from "./_base";
import type { ActionInput } from "@/shared/protocol/actions";
export async function fetchAnnouncementAction() {
  return withActionScope(async (scope) => scope.facades().announcement().get());
}
export async function acknowledgeAnnouncementAction(
  input: ActionInput<"acknowledgeAnnouncementAction">,
) {
  return withActionScope(async (scope) =>
    scope.facades().announcement().acknowledge(input),
  );
}
