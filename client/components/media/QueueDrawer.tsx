import React, { useEffect } from "react";
import Box from "@mui/material/Box";
import Drawer from "@mui/material/Drawer";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import Typography from "@mui/material/Typography";
import ClearAllIcon from "@mui/icons-material/ClearAll";
import type { MediaPlayerApi } from "@/client/hooks/useMediaPlayer";
import {
  clearMediaQueue,
  refreshMediaQueue,
  removeTrackFromQueue,
} from "@/client/interact/media";
import { useMediaStore } from "@/client/interact/mediaStore";
import { flexGap } from "@/client/lib/css";
import { TrackRow } from "./TrackRow";

export function QueueDrawer({ playerApi }: { playerApi: MediaPlayerApi }) {
  const open = useMediaStore((state) => state.queueDrawerOpen);
  const queue = useMediaStore((state) => state.queue);
  const setOpen = useMediaStore((state) => state.setQueueDrawerOpen);

  useEffect(() => {
    if (open) void refreshMediaQueue();
  }, [open]);

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={() => setOpen(false)}
      slotProps={{
        root: { sx: { zIndex: 1300 } },
        paper: {
          sx: {
            width: { xs: 320, sm: 360 },
            maxWidth: "calc(100vw - 24px)",
            display: "flex",
            flexDirection: "column",
          },
        },
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          ...flexGap(1),
          px: 2,
          py: 1.5,
          borderBottom: "1px solid",
          borderColor: "divider",
          flexShrink: 0,
        }}
      >
        <Typography variant="subtitle1" fontWeight={700} sx={{ flex: 1 }}>
          播放队列
        </Typography>
        <Typography variant="caption" color="text.disabled">
          {queue?.items.length ?? 0} 首
        </Typography>
        <IconButton
          size="small"
          title="清空队列"
          aria-label="清空队列"
          disabled={!queue || queue.items.length === 0}
          onClick={() => void clearMediaQueue()}
        >
          <ClearAllIcon fontSize="small" />
        </IconButton>
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", p: 1 }}>
        {!queue || queue.items.length === 0 ? (
          <Box
            sx={{
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "text.disabled",
            }}
          >
            <Typography variant="body2">队列是空的</Typography>
          </Box>
        ) : (
          <List dense disablePadding>
            {queue.items.map((item) => {
              const track = queue.tracks.find(
                (value) => value.id === item.track_id,
              );
              if (!track) return null;
              return (
                <TrackRow
                  key={`${queue.list.id}:${item.position}`}
                  track={track}
                  playerApi={playerApi}
                  onRemove={(id) => void removeTrackFromQueue(id)}
                />
              );
            })}
          </List>
        )}
      </Box>
    </Drawer>
  );
}
