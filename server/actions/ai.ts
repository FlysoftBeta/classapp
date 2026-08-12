import type { ActionInput } from "@/shared/protocol/actions";
import { withActionSession } from "./_base";

export async function fetchAiSidebarAction() {
  return withActionSession(async (session) =>
    (await (await session.asActor()).ai()).list(),
  );
}

export async function fetchAiConversationAction(
  input: ActionInput<"fetchAiConversationAction">,
) {
  return withActionSession(async (session) =>
    (await (await session.asActor()).ai()).detail(input.conversationId),
  );
}

export async function searchAiConversationsAction(
  input: ActionInput<"searchAiConversationsAction">,
) {
  return withActionSession(async (session) =>
    (await (await session.asActor()).ai()).search(input.query),
  );
}

export async function startAiRunAction(input: ActionInput<"startAiRunAction">) {
  return withActionSession(
    async (session) =>
      await (await (await session.asActor()).ai()).start(input),
  );
}

export async function cancelAiRunAction(
  input: ActionInput<"cancelAiRunAction">,
) {
  return withActionSession(async (session) =>
    (await (await session.asActor()).ai()).cancel(input.runId),
  );
}

export async function markAiConversationReadAction(
  input: ActionInput<"markAiConversationReadAction">,
) {
  return withActionSession(async (session) =>
    (await (await session.asActor()).ai()).markRead(input.conversationId),
  );
}

export async function adminFetchAiCreditsAction(
  input: ActionInput<"adminFetchAiCreditsAction">,
) {
  return withActionSession(async (session) =>
    (await (await session.asActor()).ai()).adminCredits(input.userId),
  );
}

export async function adminTopUpAiCreditsAction(
  input: ActionInput<"adminTopUpAiCreditsAction">,
) {
  return withActionSession(async (session) => ({
    credits: await (await (await session.asActor()).ai()).adminTopUp(input),
  }));
}
