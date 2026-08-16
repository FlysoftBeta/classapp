import React from "react";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import LinearProgress from "@mui/material/LinearProgress";
import List from "@mui/material/List";
import Popover from "@mui/material/Popover";
import Typography from "@mui/material/Typography";
import CloseIcon from "@mui/icons-material/Close";
import type { MediaPlayerApi } from "@/client/hooks/useMediaPlayer";
import { addTrackToQueue } from "@/client/interact/media";
import { useMediaStore } from "@/client/interact/mediaStore";
import { cssMin, flexGap } from "@/client/lib/css";
import { TrackRow } from "./TrackRow";

export function MediaSearchPopover({
  anchorEl,
  query,
  playerApi,
  onClose,
}: {
  anchorEl: HTMLElement | null;
  query: string;
  playerApi: MediaPlayerApi;
  onClose: () => void;
}) {
  const results = useMediaStore((state) => state.searchResults);
  const loading = useMediaStore((state) => state.searchLoading);
  const error = useMediaStore((state) => state.searchError);
  const open = anchorEl !== null;

  return (
    <Popover
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      aria-label="搜索结果"
      anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
      transformOrigin={{ vertical: "top", horizontal: "left" }}
      slotProps={{
        paper: {
          sx: {
            width: anchorEl?.clientWidth ?? 560,
            maxWidth: "calc(100vw - 32px)",
            ...cssMin(
              "maxHeight",
              "calc(100vh - 160px)",
              "min(480px, calc(100vh - 160px))",
            ),
            borderRadius: 3,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
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
          py: 1,
          borderBottom: "1px solid",
          borderColor: "divider",
          flexShrink: 0,
        }}
      >
        <Typography
          variant="subtitle2"
          fontWeight={700}
          noWrap
          sx={{ flex: 1, minWidth: 0 }}
        >
          「{query}」的搜索结果
        </Typography>
        <Typography variant="caption" color="text.disabled">
          {loading ? "搜索中" : `${results.length} 首`}
        </Typography>
        <IconButton
          size="small"
          title="关闭"
          aria-label="关闭搜索结果"
          onClick={onClose}
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>
      {loading && <LinearProgress sx={{ flexShrink: 0 }} />}
      {error && (
        <Typography color="error" variant="body2" sx={{ px: 2, py: 1 }}>
          {error}
        </Typography>
      )}
      {!loading && !error && results.length === 0 && (
        <Box
          sx={{
            px: 2,
            py: 4,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "text.disabled",
          }}
        >
          <Typography variant="body2">没有搜索结果</Typography>
        </Box>
      )}
      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", p: 1 }}>
        <List dense disablePadding>
          {results.map((track) => (
            <TrackRow
              key={track.id}
              track={track}
              playerApi={playerApi}
              onQueueAdd={(id) => void addTrackToQueue(id)}
            />
          ))}
        </List>
      </Box>
    </Popover>
  );
}
