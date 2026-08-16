import React from "react";
import BottomNavigation from "@mui/material/BottomNavigation";
import BottomNavigationAction from "@mui/material/BottomNavigationAction";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import MenuBookIcon from "@mui/icons-material/MenuBook";
import MusicNoteIcon from "@mui/icons-material/MusicNote";

export type SidebarMode = "conversations" | "ai" | "reading" | "media";

export function SidebarNavigation({
  value,
  onChange,
  aiEnabled,
  readingEnabled,
  mediaEnabled,
}: {
  value: SidebarMode;
  onChange: (value: SidebarMode) => void;
  aiEnabled: boolean;
  readingEnabled: boolean;
  mediaEnabled: boolean;
}) {
  return (
    <BottomNavigation
      value={value}
      onChange={(_event, next: SidebarMode) => onChange(next)}
      showLabels
      sx={{ borderTop: "1px solid", borderColor: "divider", flexShrink: 0 }}
    >
      <BottomNavigationAction
        value="conversations"
        label="对话"
        icon={<ChatBubbleOutlineIcon fontSize="small" />}
      />
      <BottomNavigationAction
        value="ai"
        label="AI"
        disabled={!aiEnabled}
        icon={<AutoAwesomeIcon fontSize="small" />}
      />
      <BottomNavigationAction
        value="reading"
        label="阅读"
        disabled={!readingEnabled}
        icon={<MenuBookIcon fontSize="small" />}
      />
      <BottomNavigationAction
        value="media"
        label="音乐"
        disabled={!mediaEnabled}
        icon={<MusicNoteIcon fontSize="small" />}
      />
    </BottomNavigation>
  );
}
