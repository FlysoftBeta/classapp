import { useCallback, useEffect, useRef, useState } from "react";
import type { ConvEntry, PostStreamEvent } from "./useAppLogic";
import type { AppRoute } from "@/client/interact/types";
import { conversationKeyFromPost } from "@/client/lib/chat/posts";
import { postPreview } from "@/shared/types/api/post";
import type { AiRunUpdatedPayload } from "@/shared/types/events";

interface ChatMessageBannerPayload {
  kind: "chat";
  postId: string;
  convType: "group" | "dm";
  convId: string;
  convName: string;
  senderName: string;
  preview: string;
}

interface AiMessageBannerPayload {
  kind: "ai";
  runId: string;
  conversationId: string;
  convName: string;
  preview: string;
}

export type MessageBannerPayload =
  ChatMessageBannerPayload | AiMessageBannerPayload;

const AUTO_DISMISS_MS = 4500;
const PREVIEW_MAX_LEN = 60;

function truncatePreview(text: string): string {
  if (text.length <= PREVIEW_MAX_LEN) return text;
  return `${text.slice(0, PREVIEW_MAX_LEN)}…`;
}

interface UseMessageBannerOptions {
  subscribePostEvents: (fn: (evt: PostStreamEvent) => void) => () => void;
  subscribeAiRunEvents: (fn: (evt: AiRunUpdatedPayload) => void) => () => void;
  currentUserId: string;
  conversations: ConvEntry[];
  route: AppRoute;
  isMobile: boolean;
  mobileShowContent: boolean;
  doNotDisturb: boolean;
}

export function useMessageBanner({
  subscribePostEvents,
  subscribeAiRunEvents,
  currentUserId,
  conversations,
  route,
  isMobile,
  mobileShowContent,
  doNotDisturb,
}: UseMessageBannerOptions) {
  const [banner, setBanner] = useState<MessageBannerPayload | null>(null);
  const seenEventIdsRef = useRef(new Set<string>());
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
    const eventId = payload.kind === "chat" ? payload.postId : payload.runId;
    if (seenEventIdsRef.current.has(eventId)) return;
    seenEventIdsRef.current.add(eventId);
    if (seenEventIdsRef.current.size > 200) {
      const recent = [...seenEventIdsRef.current].slice(-100);
      seenEventIdsRef.current = new Set(recent);
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
        kind: "chat",
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
    return subscribeAiRunEvents((event) => {
      if (doNotDisturb || event.run.status !== "completed") return;
      const isViewing =
        route.view === "ai" &&
        route.conversationId === event.conversation.id &&
        (!isMobile || mobileShowContent);
      if (isViewing) return;
      showBanner({
        kind: "ai",
        runId: event.run.id,
        conversationId: event.conversation.id,
        convName: event.conversation.title,
        preview: truncatePreview(event.message.content || "回复已完成"),
      });
    });
  }, [
    doNotDisturb,
    isMobile,
    mobileShowContent,
    route,
    showBanner,
    subscribeAiRunEvents,
  ]);

  useEffect(() => {
    return () => {
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    };
  }, []);

  return { banner, dismiss };
}
