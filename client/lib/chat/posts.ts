import type { Conversation, Post } from "@/shared/types/api";

export const LOAD_LIMIT = 40;

export function conversationKey(conv: Conversation) {
  return `${conv.type}:${conv.id}`;
}

export function conversationKeyFromPost(
  post: Post,
  currentUserId: string,
): { type: "group" | "dm"; id: string } | null {
  if (post.group_id) {
    return { type: "group", id: post.group_id };
  }
  if (post.dm_to && post.user_id) {
    return {
      type: "dm",
      id: post.user_id === currentUserId ? post.dm_to : post.user_id,
    };
  }
  return null;
}

export function postBelongsToConversation(
  post: Post,
  conv: Conversation,
  currentUserId: string,
) {
  if (conv.type === "group") {
    return post.group_id === conv.id && post.dm_to === null;
  }
  return (
    post.group_id === null &&
    post.dm_to !== null &&
    ((post.user_id === currentUserId && post.dm_to === conv.id) ||
      (post.user_id === conv.id && post.dm_to === currentUserId))
  );
}
