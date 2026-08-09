import React from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import SettingsIcon from "@mui/icons-material/Settings";
import AdminPanelSettingsIcon from "@mui/icons-material/AdminPanelSettings";
import TaskAltIcon from "@mui/icons-material/TaskAlt";
import type { User } from "@/shared/types/api";
import { useTaskStore } from "@/client/hooks/useTaskStore";

interface SidebarBottomProps {
  currentUser: User;
  onSettings: () => void;
  onAdmin: () => void;
  onLearning: () => void;
  onTasksAnchor: (anchorEl: HTMLElement | null) => void;
  online: boolean;
  adminEnabled: boolean;
  learningEnabled: boolean;
}

export function SidebarBottom({
  currentUser,
  onSettings,
  onAdmin,
  onLearning,
  onTasksAnchor,
  online,
  adminEnabled,
  learningEnabled,
}: SidebarBottomProps) {
  const setOpened = useTaskStore((state) => state.setOpened);

  return (
    <Box
      sx={{
        borderTop: "1px solid",
        borderColor: "divider",
        px: 1.5,
        py: 1,
        display: "flex",
        alignItems: "center",
      }}
    >
      <Typography
        variant="caption"
        sx={{ flex: 1, fontWeight: 600, color: "text.secondary" }}
        noWrap
      >
        {currentUser.username}{" "}
        <span style={{ opacity: 0.6 }}>@{currentUser.handle}</span>
      </Typography>
      {adminEnabled && (
        <Tooltip title="管理后台">
          <span>
            <IconButton size="small" onClick={onAdmin} disabled={!online}>
              <AdminPanelSettingsIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      )}
      {learningEnabled && (
        <Tooltip title="学习">
          <span>
            <IconButton size="small" onClick={onLearning} disabled={!online}>
              💪
            </IconButton>
          </span>
        </Tooltip>
      )}
      <Tooltip title="任务管理">
        <IconButton
          ref={onTasksAnchor}
          size="small"
          onClick={() => setOpened(true)}
        >
          <TaskAltIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Tooltip title="设置">
        <IconButton size="small" onClick={onSettings}>
          <SettingsIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </Box>
  );
}
