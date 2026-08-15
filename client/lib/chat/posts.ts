import type { Conversation, Post } from "@/client/interact/presentation";
import { parseConvId, peerIdFromDmConvId } from "@/shared/conversations/id";

export const LOAD_LIMIT = 40;

export function conversationKey(conv: Pick<Conversation, "conv_id">) {
  return conv.conv_id;
}

export function conversationKeyFromPost(
  post: Post,
  currentUserId: string,
): { type: "group" | "dm"; id: string } | null {
  const parsed = parseConvId(post.conv_id);
  if (parsed?.type === "group") return { type: "group", id: parsed.groupId };
  if (parsed?.type === "dm") {
    const peerId = peerIdFromDmConvId(post.conv_id, currentUserId);
    return peerId ? { type: "dm", id: peerId } : null;
  }
  return null;
}

export function postBelongsToConversation(post: Post, conv: Conversation) {
  return post.conv_id === conv.conv_id;
}
