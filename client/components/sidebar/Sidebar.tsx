import React, { useState } from "react";
import Box from "@mui/material/Box";
import type { User, ArticleWithMeta } from "@/shared/types/api";
import { CreateGroupDialog } from "./CreateGroupDialog";
import { FindGroupDialog } from "./FindGroupDialog";
import { SidebarTopProps } from "./SidebarTop";
import { ConversationSection } from "./ConversationSection";
import { ArticleSection } from "./ArticleSection";
import { SidebarBottom } from "./SidebarBottom";
import { SidebarSection } from "./SidebarSection";
import type { ConvEntry } from "@/client/interact/types";
import { TaskManagerPopover } from "@/client/components/tasks/TaskManagerPopover";
import { hasFeature } from "@/shared/features";
import { groupConvId } from "@/shared/conversations/id";

function emptyGroupEntry(g: { id: string; name: string }): ConvEntry {
  return {
    conv_id: groupConvId(g.id),
    revision: 0,
    type: "group",
    group_type: null,
    id: g.id,
    name: g.name,
    handle: null,
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
  onOpenArticle: (id: string) => void;
  sidebarArticles: ArticleWithMeta[];
  currentArticleId?: string | null;
  themeMode: "light" | "dark";
  online: boolean;
  adminEnabled: boolean;
  articlesEnabled: boolean;
  learningEnabled: boolean;
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
  onOpenArticle,
  sidebarArticles,
  currentArticleId = null,
  online,
  adminEnabled,
  articlesEnabled,
  learningEnabled,
}: ConversationListProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [convExpanded, setConvExpanded] = useState(true);
  const [articlesExpanded, setArticlesExpanded] = useState(true);
  const [tasksAnchor, setTasksAnchor] = useState<HTMLElement | null>(null);

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
      <SidebarTopProps
        onFindGroup={() => setFindOpen(true)}
        onCreateGroup={() => setCreateOpen(true)}
        online={online}
      />

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
          <SidebarSection
            title="对话"
            scrollable
            flexWeight={articlesEnabled ? 2 : 1}
            expanded={convExpanded}
            onExpandedChange={setConvExpanded}
          >
            <ConversationSection
              conversations={conversations}
              selected={selected}
              onSelect={onSelect}
            />
          </SidebarSection>
          {articlesEnabled && (
            <ArticleSection
              articles={sidebarArticles}
              currentArticleId={currentArticleId}
              onOpenArticle={onOpenArticle}
              onOpenArticles={onArticles}
              expanded={articlesExpanded}
              onExpandedChange={setArticlesExpanded}
            />
          )}
        </Box>
      </Box>

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
