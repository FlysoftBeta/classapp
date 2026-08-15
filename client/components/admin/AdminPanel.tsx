import { useMemo, useState, type ComponentType } from "react";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import BuildIcon from "@mui/icons-material/Build";
import DashboardIcon from "@mui/icons-material/Dashboard";
import DevicesIcon from "@mui/icons-material/Devices";
import EngineeringIcon from "@mui/icons-material/Engineering";
import GroupsIcon from "@mui/icons-material/Groups";
import PersonAddIcon from "@mui/icons-material/PersonAdd";
import PeopleIcon from "@mui/icons-material/People";
import ReportProblemIcon from "@mui/icons-material/ReportProblem";
import SettingsIcon from "@mui/icons-material/Settings";
import HistoryIcon from "@mui/icons-material/History";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import type { SvgIconProps } from "@mui/material/SvgIcon";
import type { User } from "@/shared/types/api";
import type { AdminRole } from "@/shared/authority";
import { UsersTab } from "./UsersTab";
import { GhostUsersTab } from "./GhostUsersTab";
import { GroupsTab } from "./GroupsTab";
import { ClientsTab } from "./ClientsTab";
import { MaintainTab } from "./MaintainTab";
import { ToolsTab } from "./ToolsTab";
import { GlobalTab } from "./GlobalTab";
import { IncidentsTab } from "./IncidentsTab";
import { AiBillingTab } from "./AiBillingTab";
import { AdminOverview } from "./AdminOverview";
import { AuditTab } from "./AuditTab";

interface AdminPanelProps {
  token: string;
  currentUser: User;
  onBack?: () => void;
}

type PageId =
  | "overview"
  | "users"
  | "ghosts"
  | "clients"
  | "groups"
  | "ai"
  | "global"
  | "operations"
  | "tools"
  | "incidents"
  | "audit";

interface PageDefinition {
  id: PageId;
  section: string;
  label: string;
  icon: ComponentType<SvgIconProps>;
  roles?: readonly AdminRole[];
}

const PAGES: readonly PageDefinition[] = [
  {
    id: "overview",
    section: "工作台",
    label: "概览",
    icon: DashboardIcon,
  },
  {
    id: "users",
    section: "干员与准入",
    label: "干员与权限",
    icon: PeopleIcon,
    roles: ["root", "feature_manager", "access_manager", "community_manager"],
  },
  {
    id: "ghosts",
    section: "人员与准入",
    label: "新干员追加",
    icon: PersonAddIcon,
    roles: ["access_manager"],
  },
  {
    id: "clients",
    section: "人员与准入",
    label: "设备管理",
    icon: DevicesIcon,
    roles: ["access_manager"],
  },
  {
    id: "groups",
    section: "社区",
    label: "群组",
    icon: GroupsIcon,
    roles: ["community_manager"],
  },
  {
    id: "ai",
    section: "产品与计费",
    label: "AI 套餐",
    icon: AutoAwesomeIcon,
    roles: ["feature_manager"],
  },
  {
    id: "global",
    section: "系统",
    label: "系统策略",
    icon: SettingsIcon,
    roles: ["operations_assistant", "advanced_community_manager"],
  },
  {
    id: "operations",
    section: "系统",
    label: "运维",
    icon: EngineeringIcon,
    roles: ["operations"],
  },
  {
    id: "tools",
    section: "系统",
    label: "协助工具",
    icon: BuildIcon,
    roles: ["operations_assistant"],
  },
  {
    id: "incidents",
    section: "系统",
    label: "Incidents",
    icon: ReportProblemIcon,
    roles: ["operations"],
  },
  {
    id: "audit",
    section: "系统",
    label: "管理审计",
    icon: HistoryIcon,
    roles: ["root"],
  },
] as const;

export default function AdminPanel({
  token,
  currentUser,
  onBack,
}: AdminPanelProps) {
  const pages = useMemo(
    () =>
      PAGES.filter(
        (page) =>
          !page.roles ||
          page.roles.some((role) =>
            currentUser.administration.roles.includes(role),
          ),
      ),
    [currentUser.administration.roles],
  );
  const [pageId, setPageId] = useState<PageId>("overview");
  const active = pages.find((page) => page.id === pageId) ?? pages[0]!;
  const sections = [...new Set(pages.map((page) => page.section))];

  const content = (() => {
    switch (active.id) {
      case "overview":
        return <AdminOverview currentUser={currentUser} />;
      case "users":
        return <UsersTab currentUser={currentUser} />;
      case "ghosts":
        return <GhostUsersTab />;
      case "clients":
        return <ClientsTab />;
      case "groups":
        return (
          <GroupsTab
            canManage={currentUser.administration.roles.includes(
              "advanced_community_manager",
            )}
          />
        );
      case "ai":
        return <AiBillingTab />;
      case "global":
        return (
          <GlobalTab
            canManageLocks={currentUser.administration.roles.includes(
              "operations_assistant",
            )}
            canPublishAnnouncement={currentUser.administration.roles.includes(
              "advanced_community_manager",
            )}
          />
        );
      case "operations":
        return <MaintainTab token={token} />;
      case "tools":
        return <ToolsTab token={token} />;
      case "incidents":
        return <IncidentsTab token={token} />;
      case "audit":
        return <AuditTab />;
    }
  })();

  return (
    <Box
      sx={{
        height: "100%",
        minHeight: 0,
        display: "grid",
        gridTemplateColumns: { xs: "1fr", md: "260px minmax(0, 1fr)" },
        overflow: "hidden",
      }}
    >
      <Box
        component="nav"
        aria-label="管理工作台导航"
        sx={{
          display: { xs: "none", md: "flex" },
          minHeight: 0,
          flexDirection: "column",
          borderRight: "1px solid",
          borderColor: "divider",
          bgcolor: "background.paper",
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", px: 1.5, py: 1.5 }}>
          {onBack ? (
            <IconButton size="small" onClick={onBack} sx={{ mr: 1 }}>
              <ArrowBackIcon fontSize="small" />
            </IconButton>
          ) : null}
          <Box>
            <Typography fontWeight={750}>管理工作台</Typography>
            <Typography variant="caption" color="text.secondary">
              按职责组织
            </Typography>
          </Box>
        </Box>
        <Divider />
        <Box sx={{ overflowY: "auto", p: 1 }}>
          {sections.map((section) => (
            <Box key={section} sx={{ mb: 1.25 }}>
              <Typography
                variant="overline"
                color="text.secondary"
                sx={{ px: 1, lineHeight: 2.5 }}
              >
                {section}
              </Typography>
              {pages
                .filter((page) => page.section === section)
                .map((page) => {
                  const Icon = page.icon;
                  const selected = active.id === page.id;
                  return (
                    <ButtonBase
                      key={page.id}
                      onClick={() => setPageId(page.id)}
                      sx={{
                        display: "grid",
                        gridTemplateColumns: "28px 1fr",
                        width: "100%",
                        textAlign: "left",
                        alignItems: "start",
                        px: 1,
                        py: 0.9,
                        borderRadius: 1.5,
                        bgcolor: selected ? "action.selected" : "transparent",
                        "&:hover": { bgcolor: "action.hover" },
                      }}
                    >
                      <Icon
                        sx={{
                          fontSize: 19,
                          mt: 0.2,
                          color: selected ? "primary.main" : "text.secondary",
                        }}
                      />
                      <Typography
                        variant="body2"
                        fontWeight={selected ? 700 : 500}
                      >
                        {page.label}
                      </Typography>
                    </ButtonBase>
                  );
                })}
            </Box>
          ))}
        </Box>
      </Box>

      <Box
        sx={{
          minWidth: 0,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <Box
          sx={{
            display: { xs: "flex", md: "none" },
            alignItems: "center",
            borderBottom: "1px solid",
            borderColor: "divider",
            overflowX: "auto",
            px: 1,
            py: 0.75,
            gap: 0.5,
          }}
        >
          {onBack ? (
            <IconButton size="small" onClick={onBack}>
              <ArrowBackIcon fontSize="small" />
            </IconButton>
          ) : null}
          {pages.map((page) => (
            <ButtonBase
              key={page.id}
              onClick={() => setPageId(page.id)}
              sx={{
                flex: "0 0 auto",
                px: 1.25,
                py: 0.75,
                borderRadius: 5,
                bgcolor:
                  active.id === page.id ? "action.selected" : "transparent",
              }}
            >
              <Typography
                variant="body2"
                fontWeight={active.id === page.id ? 700 : 500}
              >
                {page.label}
              </Typography>
            </ButtonBase>
          ))}
        </Box>
        <Box
          component="main"
          sx={{
            flex: 1,
            minHeight: 0,
            overflow: "auto",
            p: { xs: 1.5, sm: 2.5 },
            "& .MuiTableContainer-root": { maxWidth: "100%" },
            "& .MuiTableHead-root": {
              position: "sticky",
              top: 0,
              zIndex: 3,
              bgcolor: "background.paper",
            },
            "& .MuiTableCell-root:first-of-type": {
              position: "sticky",
              left: 0,
              zIndex: 2,
              bgcolor: "background.paper",
            },
          }}
        >
          <Box sx={{ mb: 2.5 }}>
            <Typography variant="h5" fontWeight={700}>
              {active.label}
            </Typography>
          </Box>
          {content}
        </Box>
      </Box>
    </Box>
  );
}
