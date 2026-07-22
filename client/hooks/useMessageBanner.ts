import { useCallback, useEffect, useRef, useState } from "react";
import type { ConvEntry, PostStreamEvent } from "./useAppLogic";
import type { AppRoute } from "./appReducer";
import { conversationKeyFromPost } from "@/client/lib/chat/posts";
import { postPreview } from "@/shared/types/api/post";

export interface MessageBannerPayload {
  postId: string;
  convType: "group" | "dm";
  convId: string;
  convName: string;
  senderName: string;
  preview: string;
}

const AUTO_DISMISS_MS = 4500;
const PREVIEW_MAX_LEN = 60;

function truncatePreview(text: string): string {
  if (text.length <= PREVIEW_MAX_LEN) return text;
  return `${text.slice(0, PREVIEW_MAX_LEN)}…`;
}

interface UseMessageBannerOptions {
  subscribePostEvents: (fn: (evt: PostStreamEvent) => void) => () => void;
  currentUserId: string;
  conversations: ConvEntry[];
  route: AppRoute;
  isMobile: boolean;
  mobileShowContent: boolean;
  doNotDisturb: boolean;
}

export function useMessageBanner({
  subscribePostEvents,
  currentUserId,
  conversations,
  route,
  isMobile,
  mobileShowContent,
  doNotDisturb,
}: UseMessageBannerOptions) {
  const [banner, setBanner] = useState<MessageBannerPayload | null>(null);
  const seenPostIdsRef = useRef(new Set<string>());
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isViewingConversation = useCallback(
    (convType: "group" | "dm", convId: string) =>
      route.view === "chat" &&
      route.conversation?.type === convType &&
      route.conversation.id === convId &&
      (!isMobile || mobileShowContent),
    [route, isMobile, mobileShowContent],
  );

  const dismiss = useCallback(() => {
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
    setBanner(null);
  }, []);

  const showBanner = useCallback((payload: MessageBannerPayload) => {
    if (seenPostIdsRef.current.has(payload.postId)) return;
    seenPostIdsRef.current.add(payload.postId);
    if (seenPostIdsRef.current.size > 200) {
      const recent = [...seenPostIdsRef.current].slice(-100);
      seenPostIdsRef.current = new Set(recent);
    }

    setBanner(payload);
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = setTimeout(() => {
      dismissTimerRef.current = null;
      setBanner(null);
    }, AUTO_DISMISS_MS);
  }, []);

  useEffect(() => {
    return subscribePostEvents((evt) => {
      if (doNotDisturb) return;
      if (evt.kind !== "post.created" || !evt.data?.post) return;

      const post = evt.data.post;
      if (post.user_id === currentUserId) return;

      const key = conversationKeyFromPost(post, currentUserId);
      if (!key) return;
      if (isViewingConversation(key.type, key.id)) return;

      const conv = conversations.find(
        (c) => c.type === key.type && c.id === key.id,
      );
      if (conv?.muted) return;
      const convName =
        conv?.name ?? (key.type === "group" ? "群组消息" : "私信");
      const senderName = post.username ?? post.handle ?? "未知用户";

      showBanner({
        postId: post.id,
        convType: key.type,
        convId: key.id,
        convName,
        senderName,
        preview: truncatePreview(postPreview(post)),
      });
    });
  }, [
    subscribePostEvents,
    currentUserId,
    conversations,
    isViewingConversation,
    showBanner,
    doNotDisturb,
  ]);

  useEffect(() => {
    return () => {
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    };
  }, []);

  return { banner, dismiss };
}
