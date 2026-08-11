import React, { useState } from "react";
import Box from "@mui/material/Box";
import Tabs from "@mui/material/Tabs";
import Tab from "@mui/material/Tab";
import Typography from "@mui/material/Typography";
import IconButton from "@mui/material/IconButton";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import type { User } from "@/shared/types/api";
import { UsersTab } from "./UsersTab";
import { GhostUsersTab } from "./GhostUsersTab";
import { GroupsTab } from "./GroupsTab";
import { PostsTab } from "./PostsTab";
import { ClientsTab } from "./ClientsTab";
import { MaintainTab } from "./MaintainTab";
import { ToolsTab } from "./ToolsTab";
import { GlobalTab } from "./GlobalTab";
import { IncidentsTab } from "./IncidentsTab";
import { flexGap } from "@/client/lib/css";

interface AdminPanelProps {
  token: string;
  currentUser: User;
  onBack?: () => void;
}

export default function AdminPanel({
  token,
  currentUser,
  onBack,
}: AdminPanelProps) {
  const [tab, setTab] = useState(0);
  void currentUser;

  return (
    <Box
      sx={{
        height: "100%",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <Box
        sx={{
          flexShrink: 0,
          zIndex: 20,
          bgcolor: "background.default",
          px: 2,
          pt: 2,
          "@media (orientation: landscape) and (max-height: 600px)": {
            px: 1,
            pt: 0.5,
            display: "flex",
            alignItems: "center",
            ...flexGap(1),
          },
        }}
      >
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            mb: 2,
            flexShrink: 0,
            "@media (orientation: landscape) and (max-height: 600px)": {
              mb: 0,
            },
          }}
        >
          {onBack && (
            <IconButton size="small" onClick={onBack} sx={{ mr: 1 }}>
              <ArrowBackIcon fontSize="small" />
            </IconButton>
          )}
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            管理后台
          </Typography>
        </Box>
        <Tabs
          value={tab}
          onChange={(_, v) => setTab(v)}
          variant="scrollable"
          scrollButtons="auto"
          allowScrollButtonsMobile
          aria-label="管理后台栏目"
          sx={{
            minWidth: 0,
            borderBottom: "1px solid",
            borderColor: "divider",
            mb: 2,
            "@media (orientation: landscape) and (max-height: 600px)": {
              flex: 1,
              mb: 0,
              minHeight: 44,
              "& .MuiTab-root": { minHeight: 44, py: 0.5 },
            },
          }}
        >
          <Tab label="干员" />
          <Tab label="招募干员" />
          <Tab label="群组" />
          <Tab label="帖子" />
          <Tab label="客户端" />
          <Tab label="全局设置" />
          <Tab label="运维" />
          <Tab label="便捷工具" />
          <Tab label="Incidents" />
        </Tabs>
      </Box>
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          "& .MuiTable-root": {
            width: "max-content",
            minWidth: "100%",
          },
          "& .MuiTableCell-root": {
            whiteSpace: "nowrap",
          },
          px: 2,
          pb: 2,
          "@media (orientation: landscape) and (max-height: 600px)": {
            px: 1,
            pb: 1,
          },
        }}
      >
        {tab === 0 && <UsersTab />}
        {tab === 1 && <GhostUsersTab />}
        {tab === 2 && <GroupsTab />}
        {tab === 3 && <PostsTab />}
        {tab === 4 && <ClientsTab />}
        {tab === 5 && <GlobalTab />}
        {tab === 6 && <MaintainTab token={token} />}
        {tab === 7 && <ToolsTab token={token} />}
        {tab === 8 && <IncidentsTab token={token} />}
      </Box>
    </Box>
  );
}
