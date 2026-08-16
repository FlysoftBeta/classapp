import React, { useState } from "react";
import Box from "@mui/material/Box";
import type { User, AiConversation, AiCreditBalance } from "@/shared/types/api";
import type { Article } from "@/client/interact/presentation";
import { CreateGroupDialog } from "./CreateGroupDialog";
import { FindGroupDialog } from "./FindGroupDialog";
import { SidebarTopProps } from "./SidebarTop";
import { ConversationSection } from "./ConversationSection";
import { ArticleSection } from "./ArticleSection";
import { SidebarBottom } from "./SidebarBottom";
import { SidebarSection } from "./SidebarSection";
import { MediaSection } from "./MediaSection";
import type { ConvEntry } from "@/client/interact/types";
import { TaskManagerPopover } from "@/client/components/tasks/TaskManagerPopover";
import { hasFeature } from "@/shared/features";
import { groupConvId } from "@/shared/conversations/id";
import { AiSection } from "./AiSection";
import { SidebarNavigation, type SidebarMode } from "./SidebarNavigation";

function emptyGroupEntry(g: { id: string; name: string }): ConvEntry {
  return {
    conv_id: groupConvId(g.id),
    revision: 0,
    type: "group",
    group_type: "normal",
    id: g.id,
    name: g.name,
    handle: g.id,
    has_password: 0,
    members_hidden: 0,
    admin_only: 0,
    no_leave: 0,
    can_post: true,
    can_leave: true,
    last_message: null,
    last_at: null,
    last_read_post_id: null,
    last_read_post_sequence: 0,
    read_updated_at_ms: 0,
    first_unread_post_id: null,
    unread_count: 0,
    pinned: 0,
    pinned_updated_at_ms: 0,
    muted: 0,
    muted_updated_at_ms: 0,
  };
}

interface ConversationListProps {
  currentUser: User;
  conversations: ConvEntry[];
  selected: ConvEntry | null;
  onSelect: (conv: ConvEntry) => void;
  onConversationsChanged: () => void;
  onSettings: () => void;
  onAdmin: () => void;
  onArticles: () => void;
  onLearning: () => void;
  onOpenMedia: () => void;
  onOpenPlaylist: (playlistId: string) => void;
  onOpenArticle: (id: string) => void;
  sidebarArticles: Article[];
  currentArticleId?: string | null;
  themeMode: "light" | "dark";
  online: boolean;
  adminEnabled: boolean;
  articlesEnabled: boolean;
  learningEnabled: boolean;
  mediaEnabled: boolean;
  aiConversations: AiConversation[];
  aiCredits: AiCreditBalance;
  aiAvailable: boolean;
  aiUnavailableReason: string | null;
  currentAiConversationId: string | null;
  initialMode: SidebarMode;
  onOpenAi: (id: string) => void;
  onNewAi: () => void;
}

export default function ConversationList({
  currentUser,
  conversations,
  selected,
  onSelect,
  onConversationsChanged,
  onSettings,
  onAdmin,
  onArticles,
  onLearning,
  onOpenMedia,
  onOpenPlaylist,
  onOpenArticle,
  sidebarArticles,
  currentArticleId = null,
  online,
  adminEnabled,
  articlesEnabled,
  learningEnabled,
  mediaEnabled,
  aiConversations,
  aiCredits,
  aiAvailable,
  aiUnavailableReason,
  currentAiConversationId,
  initialMode,
  onOpenAi,
  onNewAi,
}: ConversationListProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [convExpanded, setConvExpanded] = useState(true);
  const [articlesExpanded, setArticlesExpanded] = useState(true);
  const [mediaExpanded, setMediaExpanded] = useState(true);
  const [tasksAnchor, setTasksAnchor] = useState<HTMLElement | null>(null);
  const [mode, setMode] = useState<SidebarMode>(initialMode);

  const handleGroupCreated = (g: { id: string; name: string }) => {
    onConversationsChanged();
    onSelect(emptyGroupEntry(g));
  };

  const handleGroupJoined = (g: { id: string; name: string }) => {
    onConversationsChanged();
    onSelect(emptyGroupEntry(g));
  };

  const groupsForCreate = conversations.filter((c) => c.type === "group");

  return (
    <Box
      sx={{
        width: "100%",
        maxWidth: "100%",
        minWidth: 0,
        minHeight: 0,
        borderRight: "1px solid",
        borderColor: "divider",
        display: "flex",
        flexDirection: "column",
        height: "100%",
        bgcolor: "background.paper",
        overflow: "hidden",
      }}
    >
      {mode === "conversations" && (
        <SidebarTopProps
          onFindGroup={() => setFindOpen(true)}
          onCreateGroup={() => setCreateOpen(true)}
          online={online}
        />
      )}

      <Box
        sx={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <Box
          sx={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            width: "100%",
          }}
        >
          {mode === "conversations" && (
            <SidebarSection
              title="对话"
              scrollable
              flexWeight={1}
              expanded={convExpanded}
              onExpandedChange={setConvExpanded}
            >
              <ConversationSection
                conversations={conversations}
                selected={selected}
                onSelect={onSelect}
              />
            </SidebarSection>
          )}
          {mode === "ai" && (
            <AiSection
              conversations={aiConversations}
              credits={aiCredits}
              available={aiAvailable}
              unavailableReason={aiUnavailableReason}
              selectedId={currentAiConversationId}
              online={online}
              onOpen={onOpenAi}
              onNew={onNewAi}
            />
          )}
          {mode === "reading" && articlesEnabled && (
            <ArticleSection
              articles={sidebarArticles}
              currentArticleId={currentArticleId}
              onOpenArticle={onOpenArticle}
              onOpenArticles={onArticles}
              expanded={articlesExpanded}
              onExpandedChange={setArticlesExpanded}
            />
          )}
          {mode === "media" && mediaEnabled && (
            <MediaSection
              online={online}
              onOpenMedia={onOpenMedia}
              onOpenPlaylist={onOpenPlaylist}
              expanded={mediaExpanded}
              onExpandedChange={setMediaExpanded}
            />
          )}
        </Box>
      </Box>

      <SidebarNavigation
        value={mode}
        onChange={setMode}
        aiEnabled={hasFeature(currentUser, "ai")}
        readingEnabled={articlesEnabled}
        mediaEnabled={mediaEnabled}
      />

      <SidebarBottom
        currentUser={currentUser}
        onSettings={onSettings}
        onAdmin={onAdmin}
        onLearning={onLearning}
        online={online}
        adminEnabled={adminEnabled}
        learningEnabled={learningEnabled}
        onTasksAnchor={setTasksAnchor}
      />

      <TaskManagerPopover
        anchorEl={tasksAnchor}
        downloadEnabled={hasFeature(currentUser, "article_download")}
      />

      <CreateGroupDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={handleGroupCreated}
        joinedGroups={groupsForCreate}
      />
      <FindGroupDialog
        open={findOpen}
        onClose={() => setFindOpen(false)}
        onJoined={handleGroupJoined}
      />
    </Box>
  );
}
