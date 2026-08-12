import { client } from "@/client/interact/remote/client";
import { observeActionResult } from "@/client/api/runtime";
import { ResultTools } from "@/shared/protocol/result";

const {
  fetchAiSidebarAction,
  fetchAiConversationAction,
  searchAiConversationsAction,
  startAiRunAction,
  cancelAiRunAction,
  markAiConversationReadAction,
} = client.actions;

export async function fetchAiSidebar() {
  const result = await fetchAiSidebarAction();
  observeActionResult(result);
  return ResultTools.unwrap(result);
}

export async function fetchAiConversation(conversationId: string) {
  const result = await fetchAiConversationAction({ conversationId });
  observeActionResult(result);
  return ResultTools.unwrap(result);
}

export async function searchAiConversations(query: string) {
  const result = await searchAiConversationsAction({ query });
  observeActionResult(result);
  return ResultTools.unwrap(result).conversations;
}

export async function startAiRun(input: {
  conversationId?: string;
  content: string;
  forkFromMessageId?: string;
  images?: Array<{
    name: string;
    mime: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
    data: string;
  }>;
}) {
  const result = await startAiRunAction(input);
  observeActionResult(result);
  return ResultTools.unwrap(result);
}

export async function cancelAiRun(runId: string) {
  const result = await cancelAiRunAction({ runId });
  observeActionResult(result);
  return ResultTools.unwrap(result).cancelled;
}

export async function markAiConversationRead(conversationId: string) {
  const result = await markAiConversationReadAction({ conversationId });
  observeActionResult(result);
  return ResultTools.unwrap(result);
}
