import { withActionSession } from "./_base";
import type { ActionInput } from "@/shared/protocol/actions";
export async function fetchAnnouncementAction() {
  return withActionSession(async (session) =>
    (await (await session.asActor()).announcement()).get(),
  );
}
export async function acknowledgeAnnouncementAction(
  input: ActionInput<"acknowledgeAnnouncementAction">,
) {
  return withActionSession(async (session) =>
    (await (await session.asActor()).announcement()).acknowledge(input),
  );
}
