import React, { useState } from "react";
import { alpha } from "@mui/material/styles";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Slider from "@mui/material/Slider";
import Typography from "@mui/material/Typography";
import SkipNextIcon from "@mui/icons-material/SkipNext";
import SkipPreviousIcon from "@mui/icons-material/SkipPrevious";
import PauseIcon from "@mui/icons-material/Pause";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import CloseIcon from "@mui/icons-material/Close";
import VolumeDownIcon from "@mui/icons-material/VolumeDown";
import QueueMusicIcon from "@mui/icons-material/QueueMusic";
import MusicNoteIcon from "@mui/icons-material/MusicNote";
import type { MediaPlayerApi } from "@/client/hooks/useMediaPlayer";
import { useMediaStore } from "@/client/interact/mediaStore";
import { useApplicationStore } from "@/client/interact/appStore";
import { flexGap } from "@/client/lib/css";
import { coverUrlForTrack } from "./coverUrl";

function formatTime(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0:00";
  const total = Math.floor(value);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function NowPlayingBar({
  playerApi,
  floating,
}: {
  playerApi: MediaPlayerApi;
  floating: boolean;
}) {
  const player = useMediaStore((state) => state.player);
  const queue = useMediaStore((state) => state.queue);
  const config = useMediaStore((state) => state.config);
  const token = useApplicationStore((state) => state.token);
  const setQueueDrawerOpen = useMediaStore((state) => state.setQueueDrawerOpen);
  const [scrub, setScrub] = useState<number | null>(null);

  if (!player.currentTrackId) return null;
  const track =
    player.currentTrack ??
    queue?.tracks.find((value) => value.id === player.currentTrackId) ??
    null;
  if (!track) return null;

  const volumeCap = config?.max_volume ?? 1;
  const volumeDisabled = volumeCap <= 0;
  const maxVolume = Math.max(volumeCap, 0.01);
  const volume = volumeDisabled
    ? 0
    : Math.min(Math.max(player.userVolume, 0), volumeCap);
  const duration =
    player.durationSeconds > 0
      ? player.durationSeconds
      : track.duration_ms > 0
        ? track.duration_ms / 1000
        : 0;
  const progress =
    scrub ??
    (duration > 0
      ? Math.min(Math.max(player.progressSeconds, 0), duration)
      : 0);
  const coverUrl =
    token && track.materialization.cover.state !== "failed"
      ? coverUrlForTrack(track.id, token)
      : null;

  const playButton = (
    <IconButton
      color="primary"
      size="small"
      disabled={player.loading}
      title={player.playing ? "暂停" : "播放"}
      aria-label={player.playing ? "暂停" : "播放"}
      onClick={() => void playerApi.toggle()}
    >
      {player.loading ? (
        <CircularProgress size={20} color="inherit" />
      ) : player.playing ? (
        <PauseIcon fontSize="small" />
      ) : (
        <PlayArrowIcon fontSize="small" />
      )}
    </IconButton>
  );

  if (!floating) {
    // Collapsed capsule for non-music views; sits above the chat ComposeBar.
    return (
      <Paper
        component="section"
        role="region"
        aria-label="正在播放"
        elevation={8}
        sx={(theme) => ({
          position: "fixed",
          right: 16,
          bottom: 112,
          zIndex: 1200,
          display: "flex",
          alignItems: "center",
          ...flexGap(0.25),
          px: 0.5,
          py: 0.5,
          borderRadius: 24,
          border: "1px solid",
          borderColor: "divider",
          bgcolor: alpha(theme.palette.background.paper, 0.82),
          backdropFilter: "blur(16px)",
          WebkitBackdropFilter: "blur(16px)",
        })}
      >
        <IconButton
          size="small"
          title="下一首"
          aria-label="下一首"
          onClick={() => void playerApi.next()}
        >
          <SkipNextIcon fontSize="small" />
        </IconButton>
        {playButton}
        <IconButton
          size="small"
          title="停止播放"
          aria-label="停止播放"
          onClick={() => void playerApi.stop()}
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      </Paper>
    );
  }

  return (
    <Paper
      component="section"
      role="region"
      aria-label="正在播放"
      elevation={8}
      sx={(theme) => ({
        position: "absolute",
        left: 16,
        right: 16,
        bottom: 16,
        zIndex: 1200,
        display: "flex",
        alignItems: "center",
        ...flexGap(1),
        px: 1.5,
        py: 1,
        borderRadius: 4,
        border: "1px solid",
        borderColor: "divider",
        bgcolor: alpha(theme.palette.background.paper, 0.78),
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
      })}
    >
      {coverUrl ? (
        <Box
          component="img"
          alt=""
          src={coverUrl}
          sx={{
            width: 40,
            height: 40,
            borderRadius: 1.5,
            objectFit: "cover",
            flexShrink: 0,
            display: { xs: "none", lg: "block" },
          }}
        />
      ) : (
        <Box
          sx={{
            width: 40,
            height: 40,
            borderRadius: 1.5,
            bgcolor: "action.hover",
            display: { xs: "none", lg: "flex" },
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <MusicNoteIcon fontSize="small" color="disabled" />
        </Box>
      )}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          ...flexGap(0.25),
          flexShrink: 0,
        }}
      >
        <IconButton
          size="small"
          title="上一首"
          aria-label="上一首"
          onClick={() => void playerApi.previous()}
        >
          <SkipPreviousIcon fontSize="small" />
        </IconButton>
        {playButton}
        <IconButton
          size="small"
          title="下一首"
          aria-label="下一首"
          onClick={() => void playerApi.next()}
        >
          <SkipNextIcon fontSize="small" />
        </IconButton>
      </Box>
      <Box
        sx={{
          width: { md: 160, lg: 200 },
          minWidth: 0,
          flexShrink: 1,
          display: { xs: "none", md: "block" },
        }}
      >
        <Typography variant="body2" noWrap>
          {track.title}
        </Typography>
        <Typography variant="caption" color="text.disabled" noWrap>
          {track.artists.join(" / ") || track.album || "未知艺术家"}
        </Typography>
      </Box>
      <Slider
        size="small"
        min={0}
        max={duration > 0 ? duration : 1}
        step={0.1}
        value={duration > 0 ? progress : 0}
        disabled={duration <= 0}
        onChange={(_event, value) =>
          setScrub(typeof value === "number" ? value : progress)
        }
        onChangeCommitted={(_event, value) => {
          setScrub(null);
          if (typeof value === "number") playerApi.seek(value);
        }}
        aria-label="播放进度"
        sx={{ flex: 1, minWidth: 32, px: 0.5 }}
      />
      <Typography
        variant="caption"
        color="text.disabled"
        sx={{ flexShrink: 0, display: { xs: "none", md: "block" } }}
      >
        {formatTime(progress)} / {formatTime(duration)}
      </Typography>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          ...flexGap(0.75),
          flexShrink: 0,
        }}
      >
        <VolumeDownIcon sx={{ fontSize: 18, color: "text.disabled" }} />
        <Slider
          size="small"
          min={0}
          max={volumeDisabled ? 1 : maxVolume}
          step={0.01}
          value={volume}
          disabled={volumeDisabled}
          onChange={(_event, value) =>
            playerApi.setVolume(
              typeof value === "number" ? value : player.userVolume,
            )
          }
          aria-label="音量"
          sx={{ width: { xs: 56, sm: 64, md: 96, lg: 112 } }}
        />
      </Box>
      <IconButton
        size="small"
        title="打开播放队列"
        aria-label="打开播放队列"
        onClick={() => setQueueDrawerOpen(true)}
        sx={{ flexShrink: 0 }}
      >
        <QueueMusicIcon fontSize="small" />
      </IconButton>
    </Paper>
  );
}
