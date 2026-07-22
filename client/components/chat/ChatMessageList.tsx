import React from "react";
import Box from "@mui/material/Box";
import Fade from "@mui/material/Fade";
import Typography from "@mui/material/Typography";
import ChatPostCard from "./ChatPostCard";
import Infini2View from "@/client/components/shared/Infini2View";
import type { User, Conversation, Post } from "@/shared/types/api";
import type { ChatMessageTimeline } from "@/client/hooks/useChatPosts";

interface ChatMessageListProps {
  conversation: Conversation;
  currentUser: User;
  timeline: ChatMessageTimeline;
  onOpenArticle?: (articleId: string) => void;
  online: boolean;
}

interface ChatMessageListItemProps {
  id: string;
  post: Post;
  currentUser: User;
  setReplyTo: (post: Post | null) => void;
  onUpdated: (post: Post) => void;
  onDeleted: (id: string) => void;
  scrollToItem: (postId: string) => void;
  onOpenArticle?: (articleId: string) => void;
  online: boolean;
}

const ChatMessageListItem = React.memo(function ChatMessageListItem({
  id,
  post,
  currentUser,
  setReplyTo,
  onUpdated,
  onDeleted,
  scrollToItem,
  onOpenArticle,
  online,
}: ChatMessageListItemProps) {
  return (
    <Fade in timeout={100}>
      <Box
        data-infini-id={id}
        sx={{
          width: "100%",
        }}
      >
        <ChatPostCard
          post={post}
          currentUser={currentUser}
          onReply={setReplyTo}
          onUpdated={onUpdated}
          onDeleted={onDeleted}
          onJumpToPost={scrollToItem}
          onOpenArticle={onOpenArticle}
          online={online}
        />
      </Box>
    </Fade>
  );
});

export function ChatMessageList({
  conversation,
  currentUser,
  timeline,
  onOpenArticle,
  online,
}: ChatMessageListProps) {
  const showEmpty =
    timeline.snapshot.phase.status !== "bootstrapping" &&
    timeline.snapshot.phase.status !== "failed" &&
    timeline.itemCount === 0;
  const boundary = (text: string) => (
    <Box sx={{ textAlign: "center", py: 1.5 }}>
      <Typography variant="caption" color="text.disabled">
        —— {text} ——
      </Typography>
    </Box>
  );

  return (
    <Infini2View
      controller={timeline.controller}
      snapshot={timeline.snapshot}
      renderItem={(post, id) => (
        <ChatMessageListItem
          id={id}
          post={post}
          currentUser={currentUser}
          setReplyTo={timeline.replyToPost}
          onUpdated={timeline.updatePost}
          onDeleted={timeline.deletePost}
          scrollToItem={timeline.scrollToPost}
          onOpenArticle={onOpenArticle}
          online={online}
        />
      )}
      beforeLabel="加载更早的消息"
      afterLabel="加载更新的消息"
      onRetry={timeline.retryLoad}
      onHostChange={timeline.onHostChange}
      paddingStart={timeline.paddingStart}
      paddingEnd={timeline.paddingEnd}
      layoutBefore={5000}
      layoutAfter={5000}
      anchorRatio={0}
      header={
        !online && timeline.offlineBoundaryBefore
          ? boundary("以上内容未下载")
          : null
      }
      footer={
        !online && timeline.offlineBoundaryAfter
          ? boundary("以下内容未下载")
          : null
      }
      rootSx={{
        flex: 1,
        position: "relative",
        px: { xs: 0, sm: 0.5 },
        minHeight: 0,
      }}
      empty={
        showEmpty ? (
          <Box sx={{ p: 4, textAlign: "center" }}>
            <Typography variant="body2" color="text.disabled">
              {conversation.type === "group"
                ? "还没有消息，来发第一条吧"
                : "开始私信"}
            </Typography>
          </Box>
        ) : null
      }
    />
  );
}
