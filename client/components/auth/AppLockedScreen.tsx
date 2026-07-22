import React, { useEffect, useRef, useState } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import IconButton from "@mui/material/IconButton";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Divider from "@mui/material/Divider";
import SettingsIcon from "@mui/icons-material/Settings";

import type { AppDisableState } from "@/shared/types/api";
import { formatRemaining } from "@/shared/time";
import { inset } from "@/client/lib/css";

interface AppLockedScreenProps {
  state: AppDisableState;
  /** Auto-fires once the 30s countdown finishes. */
  onAutoLock: () => void;
  /** "Logout" menu item. */
  onLogout: () => void;
  /** Optional manual "lock now" action. */
  onLockNow: () => void;
}

function describeReason(state: AppDisableState): string {
  switch (state.reason) {
    case "banned": {
      const remaining = state.banned_until
        ? formatRemaining(state.banned_until)
        : "未知时间";
      const who = state.username ? `账号 ${state.username} ` : "";
      return `${who}已被封禁。还有 ${remaining} 才能恢复。`;
    }
    case "system_locked":
      return "系统当前已被管理员锁定。";
    case "idle":
      return "长时间无操作，已自动锁定。";
    default:
      return "应用已被锁定。";
  }
}

/**
 * AppLockedScreen — shown when a session is valid but the app is disabled
 * for that user (banned / system_locked / idle). Auto-locks back to the
 * Konami client gate after 30 seconds. A gear menu in the bottom-left lets
 * the user inspect the reason and log out.
 */
const AUTO_LOCK_MS = 30_000;

export default function AppLockedScreen({
  state,
  onAutoLock,
  onLogout,
  onLockNow,
}: AppLockedScreenProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const startedAtRef = useRef<number | null>(null);

  // 30s countdown → konami lock
  useEffect(() => {
    startedAtRef.current = performance.now();
    const id = setInterval(() => {
      const startedAt = startedAtRef.current;
      if (startedAt === null) return;
      const elapsed = performance.now() - startedAt;
      if (elapsed >= AUTO_LOCK_MS) {
        clearInterval(id);
        onAutoLock();
      }
    }, 250);
    return () => clearInterval(id);
  }, [onAutoLock]);

  return (
    <Box
      sx={{
        position: "fixed",
        bgcolor: "background.default",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        px: 3,
        color: "text.primary",
        ...inset(0),
      }}
    >
      {/* Bottom-left gear dropdown */}
      <Box sx={{ position: "fixed", left: 12, bottom: 12 }}>
        <IconButton
          size="small"
          aria-label="选项"
          onClick={(e) => setAnchor(e.currentTarget)}
          sx={{
            bgcolor: "background.paper",
            border: "1px solid",
            borderColor: "divider",
            "&:hover": { bgcolor: "action.hover" },
          }}
        >
          <SettingsIcon fontSize="small" />
        </IconButton>
        <Menu
          anchorEl={anchor}
          open={!!anchor}
          onClose={() => setAnchor(null)}
          anchorOrigin={{ vertical: "top", horizontal: "left" }}
          transformOrigin={{ vertical: "bottom", horizontal: "left" }}
        >
          <Box sx={{ px: 2, py: 1, maxWidth: 280 }}>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: "block", mb: 0.5 }}
            >
              锁定原因
            </Typography>
            <Typography variant="body2">{describeReason(state)}</Typography>
          </Box>
          <Divider />
          <MenuItem
            onClick={() => {
              setAnchor(null);
              onLockNow();
            }}
          >
            立即锁回客户端
          </MenuItem>
          <MenuItem
            onClick={() => {
              setAnchor(null);
              onLogout();
            }}
            sx={{ color: "error.main" }}
          >
            退出登录
          </MenuItem>
        </Menu>
      </Box>
    </Box>
  );
}
