import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { User, Conversation, Post } from "@/shared/types/api";
import type { PostStreamEvent } from "@/client/hooks/useAppLogic";
import type {
  Alignment,
  InfiniController,
  Provider,
  Snapshot,
} from "@infini-scroll/core";
import type { InfiniDomHost } from "@infini-scroll/dom-support";
import { useInfini } from "@infini-scroll/react";
import { markConversationRead } from "@/client/api/conversations";
import {
  fetchCachedPosts,
  fetchPost,
  fetchPosts,
  fetchRemotePosts,
} from "@/client/api/posts";
import {
  LOAD_LIMIT,
  conversationKey,
  postBelongsToConversation,
} from "@/client/lib/chat/posts";
import { offlineRepository } from "@/client/data/repository";
import { collectRevisionRange } from "@/client/data/consistency";
import { useDebugStore } from "@/client/hooks/useDebugStore";

export interface UseChatPostsParams {
  currentUser: User;
  conversation: Conversation;
  subscribePostEvents: (fn: (evt: PostStreamEvent) => void) => () => void;
  paddingStart: number;
  paddingEnd: number;
  online: boolean;
}

/** Render state and domain actions consumed by ChatMessageList. */
export interface ChatMessageTimeline {
  itemCount: number;
  controller: InfiniController<Post, ChatCursor, string, string>;
  snapshot: Snapshot<Post, string>;
  onHostChange: (
    host: InfiniDomHost<Post, ChatCursor, string, string> | null,
  ) => void;
  paddingStart: number;
  paddingEnd: number;
  replyToPost: (post: Post | null) => void;
  updatePost: (post: Post) => void;
  deletePost: (post: Post) => void;
  scrollToPost: (postId: string) => void;
  retryLoad: () => void;
  offlineBoundaryBefore: boolean;
  offlineBoundaryAfter: boolean;
  unreadBoundary: { postId: string; count: number } | null;
}

export type ChatCursor =
  { kind: "latest" } | { kind: "post"; id: string; sequence?: number };

const SCROLL_END_THRESHOLD = 64;
const ESTIMATE_POST_HEIGHT = 76;

const POST_OPS = {
  getId: (post: Post) => post.id,
  getCursor: (post: Post): ChatCursor => ({
    kind: "post",
    id: post.id,
    sequence: post.sequence,
  }),
};

function estimatePostSize(): number {
  return ESTIMATE_POST_HEIGHT;
}

function uniquePosts(posts: readonly Post[]): Post[] {
  const byId = new Map<string, Post>();
  for (const post of posts) byId.set(post.id, post);
  return [...byId.values()];
}

export function useChatPosts({
  currentUser,
  conversation,
  subscribePostEvents,
  paddingStart,
  paddingEnd,
  online,
}: UseChatPostsParams) {
  const showInfiniLogs = useDebugStore((state) => state.showInfiniLogs);
  const [replyTo, setReplyTo] = useState<Post | null>(null);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [offlineBoundaryBefore, setOfflineBoundaryBefore] = useState(false);
  const [offlineBoundaryAfter, setOfflineBoundaryAfter] = useState(false);
  const [revalidateGeneration, setRevalidateGeneration] = useState(0);
  const [fallbackToBottom, setFallbackToBottom] = useState(false);
  // Keep the entry state for this mounted conversation. Marking the
  // conversation as read updates its sidebar row while the user is still
  // looking at this list; the divider remains until they reach its end.
  const [unreadBoundary, setUnreadBoundary] = useState<{
    postId: string;
    count: number;
  } | null>(() =>
    conversation.first_unread_post_id && conversation.unread_count > 0
      ? {
          postId: conversation.first_unread_post_id,
          count: conversation.unread_count,
        }
      : null,
  );

  // Refs
  const atBottomRef = useRef(true);
  const isAtEndLocalRef = useRef<boolean | null>(null);
  const markedReadRef = useRef(false);
  const lastReadSequenceRef = useRef(conversation.last_read_post_sequence);
  const lastPostIdRef = useRef("");
  const convKeyRef = useRef("");
  const didSetLastIdRef = useRef(false);
  const previousOnlineRef = useRef(online);
  const onlineRef = useRef(online);
  const itemsRef = useRef<readonly Post[]>([]);
  const contentKeyRef = useRef("");
  const revalidationRef = useRef<Promise<void> | null>(null);
  const processedRevalidationRef = useRef(0);
  const appliedRevisionRef = useRef(conversation.revision);
  const domHostRef = useRef<InfiniDomHost<
    Post,
    ChatCursor,
    string,
    string
  > | null>(null);

  const conversationType = conversation.type;
  const conversationId = conversation.id;
  const conversationConvId = conversation.conv_id;
  const conversationRevision = conversation.revision;
  const contentKey = conversationKey(conversation);

  useLayoutEffect(() => {
    onlineRef.current = online;
    contentKeyRef.current = contentKey;
  }, [contentKey, online]);

  // ---- markRead helper ----
  const markRead = useCallback((conv: Conversation, postId: string) => {
    markConversationRead({
      type: conv.type,
      id: conv.id,
      post_id: postId,
    }).catch(() => {});
  }, []);

  const fetchDirectional = useCallback(
    async (
      cursor: ChatCursor,
      direction: "before" | "after",
      signal: AbortSignal,
      warmLatest = false,
    ) => {
      const params: Record<string, string> = { limit: String(LOAD_LIMIT) };

      if (direction === "before") {
        if (cursor.kind === "post") {
          params.before_id = cursor.id;
          const sequence =
            cursor.sequence ??
            itemsRef.current.find((post) => post.id === cursor.id)?.sequence;
          if (sequence != null) params.before_sequence = String(sequence);
        }
      } else {
        if (cursor.kind === "latest") {
          return { items: [], exhaustedBefore: false, exhaustedAfter: true };
        }
        params.after_id = cursor.id;
        const sequence =
          cursor.sequence ??
          itemsRef.current.find((post) => post.id === cursor.id)?.sequence;
        if (sequence != null) params.after_sequence = String(sequence);
      }

      const ref = {
        type: conversationType,
        id: conversationId,
        conv_id: conversationConvId,
      } as const;
      const canWarmStart =
        onlineRef.current &&
        warmLatest &&
        direction === "before" &&
        cursor.kind === "latest";
      let data = null;
      try {
        // A conversation revision describes server awareness, not cache-page
        // coverage. Even when IndexedDB contains a row at the current
        // revision, it may be the only row left after cache eviction or a
        // revision catch-up. Therefore an online latest-page bootstrap must
        // read the authoritative page instead of treating any non-empty cache
        // as a complete latest window.
        data = await fetchPosts(ref, params);
      } catch (error) {
        if (!canWarmStart) throw error;
      }
      // Preserve a usable warm start if the connection drops after the online
      // check or the authoritative request fails. Offline calls already read
      // this same cache through fetchPosts.
      if (!data && canWarmStart) data = await fetchCachedPosts(ref, params);
      if (signal.aborted) throw new Error("post request superseded");
      if (!data) throw new Error("post request failed");

      const posts = data.posts ?? [];
      const ordered = direction === "after" ? posts : [...posts].reverse();
      const hasMore = posts.length === LOAD_LIMIT;
      if (!onlineRef.current && !hasMore) {
        if (direction === "before") setOfflineBoundaryBefore(true);
        else setOfflineBoundaryAfter(true);
      }

      return {
        items: ordered,
        exhaustedBefore: direction === "before" ? !hasMore : false,
        exhaustedAfter:
          direction === "after" ? !hasMore : cursor.kind === "latest",
      };
    },
    [conversationConvId, conversationId, conversationType],
  );

  // ---- resolveItem: fetch a single post by ID for re-bootstrap ----
  const resolveItem = useCallback(
    async (id: string, authoritative = false): Promise<Post | null> => {
      const cached = (
        await offlineRepository.getPosts({
          type: conversationType,
          id: conversationId,
          conv_id: conversationConvId,
        })
      ).find((post) => post.id === id);
      if (!authoritative && cached) return cached;
      if (!onlineRef.current) return cached ?? null;
      const { data } = await fetchPost(id);
      if ("post" in data && data.post) {
        return data.post;
      }
      return null;
    },
    [conversationConvId, conversationId, conversationType],
  );

  const provider: Provider<Post, ChatCursor, string> = {
    async bootstrap({ cursor, signal }) {
      if (cursor == null || cursor.kind === "latest") {
        return fetchDirectional({ kind: "latest" }, "before", signal, true);
      }

      // An administrator can delete the post used as the read anchor. In that
      // case there is no reliable unread boundary to restore, so enter at the
      // current end instead of attempting to locate around a stale anchor.
      if (conversation.last_read_post_id) {
        const readAnchor = await resolveItem(
          conversation.last_read_post_id,
          true,
        );
        if (signal.aborted) throw new Error("post bootstrap superseded");
        if (!readAnchor || readAnchor.type === "deleted") {
          setUnreadBoundary(null);
          setFallbackToBottom(true);
          return fetchDirectional({ kind: "latest" }, "before", signal, true);
        }
      }
      const target = await resolveItem(cursor.id);
      if (signal.aborted) throw new Error("post bootstrap superseded");
      if (!target || target.type === "deleted") {
        setUnreadBoundary(null);
        setFallbackToBottom(true);
        return fetchDirectional({ kind: "latest" }, "before", signal, true);
      }
      const targetCursor: ChatCursor = {
        kind: "post",
        id: target.id,
        sequence: target.sequence,
      };
      // The initial unread window is deliberately bounded.  Its after edge is
      // therefore not necessarily the conversation end, so obtain the latest
      // item separately for the scroll-to-bottom affordance.
      const [before, after, latest] = await Promise.all([
        fetchDirectional(targetCursor, "before", signal),
        fetchDirectional(targetCursor, "after", signal),
        fetchDirectional({ kind: "latest" }, "before", signal),
      ]);
      const latestItem = latest.items[latest.items.length - 1];
      if (latestItem) lastPostIdRef.current = latestItem.id;
      return {
        items: uniquePosts([...before.items, target, ...after.items]),
        exhaustedBefore: before.exhaustedBefore,
        exhaustedAfter: after.exhaustedAfter,
      };
    },
    fetch({ cursor, direction, signal }) {
      return fetchDirectional(cursor, direction, signal);
    },
    async locateOffset({ anchor, signedItemOffset, signal }) {
      const ref = {
        type: conversationType,
        id: conversationId,
        conv_id: conversationConvId,
      } as const;
      const targetSequence = Math.max(
        1,
        (anchor.sequence ?? 1) + signedItemOffset,
      );
      let target: Post | undefined;
      if (!onlineRef.current) {
        const cached = await offlineRepository.getPosts(ref);
        target = cached.reduce<Post | undefined>((nearest, post) => {
          if (post.sequence == null) return nearest;
          if (!nearest?.sequence) return post;
          return Math.abs(post.sequence - targetSequence) <
            Math.abs(nearest.sequence - targetSequence)
            ? post
            : nearest;
        }, undefined);
      } else {
        const data = await fetchPosts(ref, {
          limit: "1",
          before_id: "__infini_sequence_cursor__",
          before_sequence: String(targetSequence + 1),
        });
        target = data?.posts?.[0];
      }
      if (signal.aborted) throw new Error("post locate request superseded");
      if (!target) throw new Error("post locate request found no target");
      return {
        cursor: {
          kind: "post",
          id: target.id,
          sequence: target.sequence,
        },
        targetId: target.id,
      };
    },
  };

  const { controller, snapshot } = useInfini<Post, ChatCursor, string, string>({
    debug: showInfiniLogs
      ? `ChatMessageList:${conversationType}:${conversationId}`
      : undefined,
    provider,
    ops: POST_OPS,
    estimateSize: estimatePostSize,
    initial: unreadBoundary
      ? {
          cursor: { kind: "post", id: unreadBoundary.postId },
          target: unreadBoundary.postId,
          alignment: "start",
        }
      : { cursor: { kind: "latest" }, alignment: "end" },
    targetToCursor: (id) => ({ kind: "post", id }),
    locateTarget: (posts, id) =>
      posts.some((post) => post.id === id) ? id : null,
    residentBefore: 16,
    residentAfter: 16,
    defaultItemEstimate: ESTIMATE_POST_HEIGHT,
  });

  const loadState = snapshot;
  const items = snapshot.mainItems.map((row) => row.item);

  const mutateItems = useCallback(
    (mutate: (item: Post) => Post) => {
      controller.updateExternal(
        controller.getSnapshot().mainItems.map((row) => mutate(row.item)),
      );
    },
    [controller],
  );

  const pushItems = useCallback(
    (
      direction: "before" | "after",
      pushedItems: readonly Post[],
      exhaustedBefore?: boolean,
      exhaustedAfter?: boolean,
    ) => {
      if (!pushedItems.length) return;
      if (exhaustedBefore === false) controller.reopen("before");
      if (exhaustedAfter === false) controller.reopen("after");
      const current = controller.getSnapshot().mainItems;
      if (!current.length) {
        const target =
          direction === "before"
            ? pushedItems[0]!
            : pushedItems[pushedItems.length - 1]!;
        controller.jump(target.id, {
          direction,
          alignment: direction === "after" ? "end" : "start",
        });
        return;
      }
      controller.updateExternal(pushedItems);
      const anchor =
        direction === "before"
          ? current[0]!.id
          : current[current.length - 1]!.id;
      controller.insertExternal({
        anchor,
        side: direction,
        items: pushedItems,
      });
    },
    [controller],
  );

  const scrollToTarget = useCallback(
    (id: string, options?: { alignment?: Alignment }) => {
      const alignment = options?.alignment ?? "nearest";
      if (domHostRef.current?.scrollToItem(id, alignment)) return;
      controller.jump(id, { alignment });
    },
    [controller],
  );

  useEffect(() => {
    if (!fallbackToBottom || !items.length) return;
    const lastId = items[items.length - 1]!.id;
    const frame = requestAnimationFrame(() => {
      scrollToTarget(lastId, { alignment: "end" });
      setFallbackToBottom(false);
    });
    return () => cancelAnimationFrame(frame);
  }, [fallbackToBottom, items, scrollToTarget]);

  const isAtEnd = useCallback(
    (threshold: number) => {
      const current = controller.getSnapshot();
      return current.visible.end >= current.mainExtent - threshold;
    },
    [controller],
  );

  const clearExhausted = useCallback(
    (direction: "before" | "after") => controller.reopen(direction),
    [controller],
  );

  const onHostChange = useCallback(
    (host: InfiniDomHost<Post, ChatCursor, string, string> | null) => {
      domHostRef.current = host;
    },
    [],
  );

  useLayoutEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const revalidateVisiblePosts = useCallback(() => {
    if (!onlineRef.current || revalidationRef.current) return false;
    const runKey = contentKey;
    const ref = {
      type: conversationType,
      id: conversationId,
      conv_id: conversationConvId,
    } as const;
    const run = (async () => {
      const held = [...itemsRef.current];
      const sinceRevision = appliedRevisionRef.current;
      if (conversationRevision <= sinceRevision) return;
      const rows = await collectRevisionRange(
        sinceRevision,
        conversationRevision,
        async (cursor, through, limit) => {
          const data = await fetchRemotePosts(ref, {
            changed_after_revision: String(cursor),
            changed_through_revision: String(through),
            limit: String(limit),
          });
          if (!data) throw new Error("Post revision catch-up failed");
          return data.posts;
        },
      );
      if (contentKeyRef.current !== runKey) return;
      const changed = new Map(rows.map((post) => [post.id, post]));

      if (changed.size) {
        mutateItems((item) => {
          const remote = changed.get(item.id);
          return remote && remote.revision >= item.revision ? remote : item;
        });
      }

      const maxSequence = held.reduce(
        (max, post) => Math.max(max, post.sequence ?? 0),
        0,
      );
      const heldIds = new Set(held.map((post) => post.id));
      const appended = loadState.exhaustedAfter
        ? [...changed.values()]
            .filter(
              (post) =>
                !heldIds.has(post.id) && (post.sequence ?? 0) > maxSequence,
            )
            .sort(
              (a, b) =>
                (a.sequence ?? 0) - (b.sequence ?? 0) ||
                a.created_at.localeCompare(b.created_at),
            )
        : [];
      appliedRevisionRef.current = Math.max(
        sinceRevision,
        conversationRevision,
        ...[...changed.values()].map((post) => post.revision),
      );
      if (!appended.length) return;
      const wasAtBottom = atBottomRef.current;
      const last = appended[appended.length - 1]!;
      lastPostIdRef.current = last.id;
      markedReadRef.current = false;
      pushItems("after", appended, undefined, true);
      if (wasAtBottom) {
        scrollToTarget(last.id, { alignment: "end" });
        markRead(conversation, last.id);
        markedReadRef.current = true;
      }
    })()
      .catch(() => {
        /* connection changed again; the next recovery retries */
      })
      .finally(() => {
        if (revalidationRef.current === run) revalidationRef.current = null;
        if (contentKeyRef.current !== runKey && onlineRef.current) {
          setRevalidateGeneration((value) => value + 1);
        }
      });
    revalidationRef.current = run;
    return true;
  }, [
    contentKey,
    conversation,
    conversationConvId,
    conversationId,
    conversationRevision,
    conversationType,
    loadState.exhaustedAfter,
    markRead,
    mutateItems,
    pushItems,
    scrollToTarget,
  ]);

  useEffect(() => {
    const wasOnline = previousOnlineRef.current;
    previousOnlineRef.current = online;
    if (!online || wasOnline) return;
    const frame = requestAnimationFrame(() => {
      setOfflineBoundaryBefore(false);
      setOfflineBoundaryAfter(false);
      // Keep the known end closed until the authoritative catch-up below has
      // merged all current rows newer than our last applied revision.
      clearExhausted("before");
      setRevalidateGeneration((value) => value + 1);
    });
    return () => cancelAnimationFrame(frame);
  }, [online, clearExhausted]);

  useEffect(() => {
    if (
      revalidateGeneration === 0 ||
      processedRevalidationRef.current === revalidateGeneration ||
      loadState.phase.status !== "ready"
    )
      return;
    if (revalidateVisiblePosts()) {
      processedRevalidationRef.current = revalidateGeneration;
    }
  }, [loadState.phase.status, revalidateGeneration, revalidateVisiblePosts]);

  useEffect(() => {
    if (online && conversationRevision > appliedRevisionRef.current) {
      setRevalidateGeneration((value) => value + 1);
    }
  }, [conversationRevision, online]);

  useLayoutEffect(() => {
    didSetLastIdRef.current = false;
    // The first layout measurement must always synchronize the affordance.
    // In particular, an unread window can open away from Content End; seeding
    // this as `false` would make updateAtBottom skip that initial result and
    // leave the scroll-to-bottom button hidden.
    isAtEndLocalRef.current = null;
    lastReadSequenceRef.current = conversation.last_read_post_sequence;
  }, [contentKey, conversation]);

  // ---- Conversation switch: reset state ----
  useEffect(() => {
    if (convKeyRef.current === contentKey) return;
    convKeyRef.current = contentKey;
    appliedRevisionRef.current = conversation.revision;

    setReplyTo(null);
    lastPostIdRef.current = "";
    atBottomRef.current = true;
    setShowScrollDown(false);
    markedReadRef.current = false;
  }, [contentKey, conversation.revision]);

  const markReadAtBottom = useCallback(() => {
    const lastId = lastPostIdRef.current;
    if (!markedReadRef.current && lastId) {
      markRead(conversation, lastId);
      markedReadRef.current = true;
    }
  }, [conversation, markRead]);

  const updateReadProgress = useCallback(() => {
    // Keep the entry divider as an opening-session landmark, but advance the
    // persisted read cursor as messages become fully visible while scrolling.
    // It is removed only after the user reaches the actual conversation end.
    if (!unreadBoundary) return;
    const current = controller.getSnapshot();
    const lastVisible = [...current.mainItems]
      .reverse()
      .find((row) => row.start + row.extent <= current.visible.end);
    if (!lastVisible) return;
    const post = lastVisible.item;
    if ((post.sequence ?? 0) <= lastReadSequenceRef.current) return;
    lastReadSequenceRef.current = post.sequence ?? lastReadSequenceRef.current;
    markRead(conversation, post.id);
  }, [controller, conversation, markRead, unreadBoundary]);

  const updateAtBottom = useCallback(() => {
    const atEnd = loadState.exhaustedAfter && isAtEnd(SCROLL_END_THRESHOLD);
    updateReadProgress();
    if (atEnd === isAtEndLocalRef.current) return;
    isAtEndLocalRef.current = atEnd;
    atBottomRef.current = atEnd;
    setShowScrollDown(!atEnd);
    if (atEnd) {
      markReadAtBottom();
      setUnreadBoundary(null);
    }
  }, [isAtEnd, loadState.exhaustedAfter, markReadAtBottom, updateReadProgress]);

  // Learn the absolute last ID once the initial latest-page bootstrap reaches
  // Content End. Live events and successful posts update it afterwards.
  useEffect(() => {
    if (didSetLastIdRef.current || !loadState.exhaustedAfter) return;
    const lastItem = items[items.length - 1];
    if (!lastItem) return;
    didSetLastIdRef.current = true;
    lastPostIdRef.current = lastItem.id;
  }, [items, loadState.exhaustedAfter]);

  // A short list can reach the end after layout without emitting a scroll.
  useEffect(() => {
    const frame = requestAnimationFrame(updateAtBottom);
    return () => cancelAnimationFrame(frame);
  }, [items.length, updateAtBottom]);

  useEffect(() => {
    let frame: number | null = null;
    let lastEmit = 0;
    const onScroll = () => {
      if (frame != null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        const now = Date.now();
        if (now - lastEmit < 80) return;
        lastEmit = now;
        updateAtBottom();
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame != null) cancelAnimationFrame(frame);
    };
  }, [updateAtBottom]);

  const pushUniqueItems = useCallback(
    (
      direction: "before" | "after",
      pushedItems: Post[],
      exhaustedBefore?: boolean,
      exhaustedAfter?: boolean,
    ) => {
      // Appending a live item to a window that has not reached Content End
      // would create a hole. The following jump will re-bootstrap around it.
      if (direction === "after" && !loadState.exhaustedAfter) return;
      pushItems(direction, pushedItems, exhaustedBefore, exhaustedAfter);
    },
    [loadState.exhaustedAfter, pushItems],
  );

  const scrollToPost = useCallback(
    (postId: string, alignment?: Alignment) => {
      scrollToTarget(postId, alignment ? { alignment } : undefined);
    },
    [scrollToTarget],
  );

  // ---- WebSocket post stream ----
  useEffect(() => {
    return subscribePostEvents((evt) => {
      if (!conversation) return;

      if (evt.kind === "post.created" && evt.data?.post) {
        const post = evt.data.post;
        if (!postBelongsToConversation(post, conversation)) return;

        lastPostIdRef.current = post.id;
        void offlineRepository.savePosts(conversation, [post]);
        appliedRevisionRef.current = Math.max(
          appliedRevisionRef.current,
          post.revision,
        );
        markedReadRef.current = false;
        pushUniqueItems("after", [post]);

        if (atBottomRef.current) {
          // Keep the new message visible — scroll to the newly pushed item
          // with "end" alignment so it sticks to the bottom.
          scrollToPost(post.id, "end");
          markRead(conversation, post.id);
          markedReadRef.current = true;
        }
        return;
      }

      if (evt.kind === "post.updated" && evt.data?.post) {
        const post = evt.data.post;
        if (!postBelongsToConversation(post, conversation)) return;
        void offlineRepository.savePosts(conversation, [post]);
        appliedRevisionRef.current = Math.max(
          appliedRevisionRef.current,
          post.revision,
        );
        mutateItems((item) => (item.id === post.id ? post : item));
        return;
      }

      if (evt.kind === "post.deleted" && evt.data?.post) {
        const post = evt.data.post;
        if (!postBelongsToConversation(post, conversation)) return;
        void offlineRepository.savePosts(conversation, [post]);
        appliedRevisionRef.current = Math.max(
          appliedRevisionRef.current,
          post.revision,
        );
        mutateItems((item) => (item.id === post.id ? post : item));
      }
    });
  }, [
    subscribePostEvents,
    currentUser.id,
    markRead,
    conversation,
    mutateItems,
    pushUniqueItems,
    scrollToPost,
  ]);

  // ---- User actions ----
  const scrollToBottom = useCallback(() => {
    const lastId = lastPostIdRef.current;
    if (lastId) {
      scrollToPost(lastId, "end");
      markRead(conversation, lastId);
      markedReadRef.current = true;
    }
  }, [conversation, markRead, scrollToPost]);

  /** Called when the user sends a new message (optimistic append). */
  const handlePosted = useCallback(
    (post: Post) => {
      lastPostIdRef.current = post.id;
      pushUniqueItems("after", [post]);
      // A create response and its WebSocket event may arrive in either order.
      // ChatMessageList makes the append idempotent and defers this scroll
      // until the post is committed, avoiding a false re-bootstrap.
      scrollToPost(post.id, "end");
      markRead(conversation, post.id);
      markedReadRef.current = true;
    },
    [conversation, markRead, pushUniqueItems, scrollToPost],
  );

  /** Called by ChatPostCard when a post is edited. */
  const handleUpdated = useCallback(
    (updated: Post) => {
      mutateItems((item) => (item.id === updated.id ? updated : item));
    },
    [mutateItems],
  );

  /** Called by ChatPostCard when a post is deleted. */
  const handleDeleted = useCallback(
    (post: Post) => {
      void offlineRepository.savePosts(conversation, [post]);
      mutateItems((item) => (item.id === post.id ? post : item));
    },
    [conversation, mutateItems],
  );

  const clearReplyTo = useCallback(() => setReplyTo(null), []);

  const timeline = useMemo<ChatMessageTimeline>(
    () => ({
      itemCount: items.length,
      controller,
      snapshot,
      onHostChange,
      paddingStart,
      paddingEnd,
      replyToPost: setReplyTo,
      updatePost: handleUpdated,
      deletePost: handleDeleted,
      scrollToPost,
      retryLoad: () => controller.retry(),
      offlineBoundaryBefore,
      offlineBoundaryAfter,
      unreadBoundary,
    }),
    [
      controller,
      handleDeleted,
      handleUpdated,
      items.length,
      onHostChange,
      paddingEnd,
      paddingStart,
      scrollToPost,
      snapshot,
      offlineBoundaryBefore,
      offlineBoundaryAfter,
      unreadBoundary,
    ],
  );

  return {
    replyTo,
    clearReplyTo,
    showScrollDown,
    scrollToBottom,
    handlePosted,
    timeline,
  };
}
