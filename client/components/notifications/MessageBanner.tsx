import React, { useCallback, useRef } from "react";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import Slide from "@mui/material/Slide";
import IconButton from "@mui/material/IconButton";
import GroupsIcon from "@mui/icons-material/Groups";
import PersonIcon from "@mui/icons-material/Person";
import CloseIcon from "@mui/icons-material/Close";
import type { MessageBannerPayload } from "@/client/hooks/useMessageBanner";
import { cssMin, flexGap } from "@/client/lib/css";

interface MessageBannerProps {
  banner: MessageBannerPayload | null;
  onDismiss: () => void;
  onOpenConversation: (convType: "group" | "dm", convId: string) => void;
}

const SWIPE_DISMISS_THRESHOLD = 48;

export default function MessageBanner({
  banner,
  onDismiss,
  onOpenConversation,
}: MessageBannerProps) {
  const touchStartYRef = useRef<number | null>(null);

  const handleClick = useCallback(() => {
    if (!banner) return;
    onOpenConversation(banner.convType, banner.convId);
    onDismiss();
  }, [banner, onOpenConversation, onDismiss]);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartYRef.current = e.touches[0]?.clientY ?? null;
  }, []);

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      const startY = touchStartYRef.current;
      touchStartYRef.current = null;
      if (startY == null) return;
      const endY = e.changedTouches[0]?.clientY ?? startY;
      if (startY - endY >= SWIPE_DISMISS_THRESHOLD) {
        onDismiss();
      }
    },
    [onDismiss],
  );

  const Icon = banner?.convType === "group" ? GroupsIcon : PersonIcon;

  return (
    <Box
      sx={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 1100,
        px: 1.5,
        ...cssMin("paddingTop", "8px", "max(8px, env(safe-area-inset-top))"),
        pointerEvents: "none",
      }}
      aria-live="polite"
    >
      <Slide direction="down" in={banner != null} mountOnEnter unmountOnExit>
        <Paper
          role="status"
          elevation={6}
          onClick={handleClick}
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
          sx={{
            pointerEvents: "auto",
            display: "flex",
            alignItems: "center",
            ...flexGap(1.5),
            px: 1.5,
            py: 1.25,
            borderRadius: 2.5,
            cursor: "pointer",
            bgcolor: "background.paper",
            border: "1px solid",
            borderColor: "divider",
            maxWidth: 480,
            mx: "auto",
            "&:active": { bgcolor: "action.hover" },
          }}
        >
          <Box
            sx={{
              width: 40,
              height: 40,
              borderRadius: "50%",
              bgcolor: "primary.main",
              color: "primary.contrastText",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            {banner && <Icon sx={{ fontSize: 22 }} />}
          </Box>

          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="subtitle2" fontWeight={700} noWrap>
              {banner?.convName}
            </Typography>
            <Typography variant="body2" color="text.secondary" noWrap>
              {banner ? `${banner.senderName}：${banner.preview}` : ""}
            </Typography>
          </Box>

          <IconButton
            size="small"
            aria-label="关闭通知"
            onClick={(e) => {
              e.stopPropagation();
              onDismiss();
            }}
            sx={{ flexShrink: 0 }}
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        </Paper>
      </Slide>
    </Box>
  );
}
