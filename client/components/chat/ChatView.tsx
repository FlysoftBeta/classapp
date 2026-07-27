import React from "react";
import { alpha } from "@mui/material/styles";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import IconButton from "@mui/material/IconButton";
import Fade from "@mui/material/Fade";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import type { User, Conversation } from "@/shared/types/api";
import type {
  PostStreamEvent,
  UserConfigChangedEvent,
} from "@/client/hooks/useAppLogic";
import { useChatPosts } from "@/client/hooks/useChatPosts";
import { MembersDialog } from "./MembersDialog";
import { DiscoverGroupsDialog } from "./DiscoverGroupsDialog";
import { ConversationSettingsMenu } from "./ConversationSettingsMenu";
import { MessageComposeBar } from "./MessageComposeBar";
import { ChatMessageList } from "./ChatMessageList";
import { vh } from "@/client/lib/css";
import { useObservedElementHeight } from "@/client/hooks/useObservedElementHeight";

export interface ChatViewProps {
  currentUser: User;
  token: string;
  conversation: Conversation | null;
  onStartDm: (peerId: string, peerName: string) => void;
  onConversationUpdate: () => void;
  onLeftGroup?: (groupId: string) => void;
  subscribePostEvents: (fn: (evt: PostStreamEvent) => void) => () => void;
  subscribeConfigEvents?: (
    fn: (evt: UserConfigChangedEvent) => void,
  ) => () => void;
  onBack?: () => void;
  onOpenArticle?: (articleId: string) => void;
  online: boolean;
  offlineEnabled: boolean;
  articlesEnabled: boolean;
}

interface ChatBodyProps {
  currentUser: User;
  token: string;
  conversation: Conversation;
  subscribePostEvents: ChatViewProps["subscribePostEvents"];
  subscribeConfigEvents: ChatViewProps["subscribeConfigEvents"];
  onOpenArticle: ChatViewProps["onOpenArticle"];
  paddingStart: number;
  online: boolean;
  articlesEnabled: boolean;
}

const MemoizedMessageComposeBar = React.memo(MessageComposeBar);

function ChatBody({
  currentUser,
  token,
  conversation,
  subscribePostEvents,
  subscribeConfigEvents,
  onOpenArticle,
  paddingStart,
  online,
  articlesEnabled,
}: ChatBodyProps) {
  const [composeRef, composeHeight] =
    useObservedElementHeight<HTMLDivElement>();
  const {
    replyTo,
    clearReplyTo,
    showScrollDown,
    scrollToBottom,
    handlePosted,
    timeline,
  } = useChatPosts({
    currentUser,
    conversation,
    subscribePostEvents,
    paddingStart,
    paddingEnd: composeHeight,
    online,
  });

  return (
    <>
      <ChatMessageList
        conversation={conversation}
        currentUser={currentUser}
        timeline={timeline}
        onOpenArticle={onOpenArticle}
        online={online}
      />

      <Fade in={showScrollDown} unmountOnExit>
        <Box
          sx={{
            position: "sticky",
            bottom: 88,
            zIndex: 30,
            height: 0,
            flexShrink: 0,
            pointerEvents: "none",
          }}
        >
          <IconButton
            size="small"
            aria-label="回到底部"
            onClick={scrollToBottom}
            sx={{
              position: "absolute",
              right: 20,
              bottom: 0,
              pointerEvents: "auto",
              bgcolor: "background.paper",
              border: "1px solid",
              borderColor: "divider",
              boxShadow: 2,
              "&:hover": { bgcolor: "action.hover" },
            }}
          >
            <KeyboardArrowDownIcon fontSize="small" />
          </IconButton>
        </Box>
      </Fade>

      <MemoizedMessageComposeBar
        currentUser={currentUser}
        token={token}
        conversation={conversation}
        replyTo={replyTo}
        onClearReply={clearReplyTo}
        onPosted={handlePosted}
        subscribeConfigEvents={subscribeConfigEvents}
        rootRef={composeRef}
        online={online}
        articlesEnabled={articlesEnabled}
      />
    </>
  );
}

export default function ChatView({
  currentUser,
  token,
  conversation,
  onStartDm,
  onConversationUpdate,
  onLeftGroup,
  subscribePostEvents,
  subscribeConfigEvents,
  onBack,
  onOpenArticle,
  online,
  offlineEnabled,
  articlesEnabled,
}: ChatViewProps) {
  const [headerRef, headerHeight] = useObservedElementHeight<HTMLDivElement>();

  if (!conversation) {
    return (
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "text.disabled",
        }}
      >
        <Typography variant="body2">从左侧选择一个对话</Typography>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        minHeight: vh(1),
        position: "relative",
      }}
    >
      <Box
        ref={headerRef}
        sx={(theme) => ({
          position: "sticky",
          top: 0,
          zIndex: 20,
          bgcolor: alpha(theme.palette.background.paper, 0.72),
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
        })}
      >
        <Box
          sx={{
            px: { xs: 1, sm: 2 },
            py: 1.5,
            borderBottom: "1px solid",
            borderColor: "divider",
            display: "flex",
            alignItems: "center",
            flexShrink: 0,
          }}
        >
          {onBack && (
            <IconButton size="small" onClick={onBack} sx={{ mr: 0.5 }}>
              <ArrowBackIcon fontSize="small" />
            </IconButton>
          )}
          <Typography
            variant="subtitle2"
            fontWeight={700}
            sx={{ flex: 1 }}
            noWrap
          >
            {conversation.type === "group"
              ? `# ${conversation.name}`
              : `@ ${conversation.name}`}
          </Typography>
          {conversation.type === "group" && (
            <>
              <DiscoverGroupsDialog
                groupId={conversation.id}
                groupName={conversation.name}
                onJoined={onConversationUpdate}
              />
              <MembersDialog
                groupId={conversation.id}
                currentUserId={currentUser.id}
                onStartDm={onStartDm}
                onLeft={(id) => {
                  onLeftGroup?.(id);
                  onConversationUpdate();
                }}
              />
            </>
          )}
          <ConversationSettingsMenu
            conversation={conversation}
            online={online}
            offlineEnabled={offlineEnabled}
          />
        </Box>
      </Box>

      <ChatBody
        key={`${conversation.type}:${conversation.id}`}
        conversation={conversation}
        currentUser={currentUser}
        token={token}
        subscribePostEvents={subscribePostEvents}
        subscribeConfigEvents={subscribeConfigEvents}
        onOpenArticle={onOpenArticle}
        paddingStart={headerHeight}
        online={online}
        articlesEnabled={articlesEnabled}
      />
    </Box>
  );
}
