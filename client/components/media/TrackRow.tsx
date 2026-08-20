import React, { type ReactNode } from "react";
import type { MediaTrack } from "@/shared/media/types";
import type { MediaPlayerApi } from "@/client/hooks/useMediaPlayer";
import { useMediaStore } from "@/client/interact/mediaStore";
import { useApplicationStore } from "@/client/interact/appStore";
import { flexGap } from "@/client/lib/css";
import { trackCoverUrl } from "./coverUrl";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import ListItem from "@mui/material/ListItem";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import MusicNoteIcon from "@mui/icons-material/MusicNote";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import GraphicEqIcon from "@mui/icons-material/GraphicEq";
import QueueMusicIcon from "@mui/icons-material/QueueMusic";
import RemoveCircleOutlineIcon from "@mui/icons-material/RemoveCircleOutline";
import CloudDownloadIcon from "@mui/icons-material/CloudDownload";
import FavoriteIcon from "@mui/icons-material/Favorite";
import FavoriteBorderIcon from "@mui/icons-material/FavoriteBorder";
import Typography from "@mui/material/Typography";
import { setTrackFavorite } from "@/client/interact/media";
import { AddToPlaylistButton } from "./AddToPlaylistButton";

function stateLabel(track: MediaTrack): string {
  const audio = track.materialization.audio.state;
  if (audio === "ready") return "已缓存";
  if (audio === "downloading" || audio === "queued") return "下载中";
  if (audio === "failed") return "下载失败";
  return "在线";
}

export function TrackRow({
  track,
  playerApi,
  onQueueAdd,
  onRemove,
  removeTitle = "移出播放队列",
  playlistId,
}: {
  track: MediaTrack;
  playerApi: MediaPlayerApi;
  onQueueAdd?: (trackId: string) => void;
  onRemove?: (trackId: string) => void;
  removeTitle?: string;
  playlistId?: string;
}) {
  const currentTrackId = useMediaStore((state) => state.player.currentTrackId);
  const playing = useMediaStore((state) => state.player.playing);
  const token = useApplicationStore((state) => state.token);
  const isCurrent = track.id === currentTrackId;
  const favoriteTrackIds = useMediaStore((state) => state.favoriteTrackIds);
  const favorited = favoriteTrackIds.has(track.id);
  const coverUrl = trackCoverUrl(track, token);

  const handleActivate = () => {
    if (isCurrent) {
      void playerApi.toggle();
    } else {
      void playerApi.playTrack(track, playlistId ? { playlistId } : undefined);
    }
  };

  const secondaryAction: ReactNode = (
    <Box sx={{ display: "flex", alignItems: "center", ...flexGap(0.25) }}>
      <IconButton
        edge="end"
        size="small"
        title={favorited ? "取消收藏" : "收藏"}
        onClick={(event) => {
          event.stopPropagation();
          void setTrackFavorite(track.id, !favorited);
        }}
      >
        {favorited ? (
          <FavoriteIcon fontSize="small" color="primary" />
        ) : (
          <FavoriteBorderIcon fontSize="small" />
        )}
      </IconButton>
      <AddToPlaylistButton trackId={track.id} excludePlaylistId={playlistId} />
      {onQueueAdd && (
        <IconButton
          edge="end"
          size="small"
          title="加入播放队列"
          onClick={(event) => {
            event.stopPropagation();
            onQueueAdd(track.id);
          }}
        >
          <QueueMusicIcon fontSize="small" />
        </IconButton>
      )}
      {onRemove && (
        <IconButton
          edge="end"
          size="small"
          title={removeTitle}
          onClick={(event) => {
            event.stopPropagation();
            onRemove(track.id);
          }}
        >
          <RemoveCircleOutlineIcon fontSize="small" />
        </IconButton>
      )}
    </Box>
  );

  return (
    <ListItem disablePadding secondaryAction={secondaryAction}>
      <ListItemButton
        selected={isCurrent}
        onClick={handleActivate}
        aria-label={playing ? `暂停 ${track.title}` : `播放 ${track.title}`}
        sx={{ borderRadius: 2 }}
      >
        {coverUrl ? (
          <Box
            component="img"
            alt=""
            src={coverUrl}
            sx={{
              width: 40,
              height: 40,
              borderRadius: 1,
              mr: 1,
              objectFit: "cover",
              flexShrink: 0,
            }}
          />
        ) : (
          <Box
            sx={{
              width: 40,
              height: 40,
              borderRadius: 1,
              bgcolor: "action.hover",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              mr: 1,
              flexShrink: 0,
            }}
          >
            <MusicNoteIcon fontSize="small" color="disabled" />
          </Box>
        )}
        {isCurrent && playing ? (
          <GraphicEqIcon
            color="primary"
            sx={{ mr: 1, flexShrink: 0, fontSize: 24 }}
          />
        ) : (
          <PlayArrowIcon
            color={isCurrent ? "primary" : "disabled"}
            sx={{ mr: 1, flexShrink: 0, fontSize: 24 }}
          />
        )}
        <ListItemText
          primary={track.title}
          secondary={track.artists.join(" / ") || track.album || "未知艺术家"}
          primaryTypographyProps={{ noWrap: true }}
          secondaryTypographyProps={{ noWrap: true }}
        />
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            ...flexGap(0.5),
            pr: 1,
            flexShrink: 0,
          }}
        >
          {track.materialization.audio.state !== "ready" && (
            <CloudDownloadIcon sx={{ fontSize: 14, color: "text.disabled" }} />
          )}
          <Typography variant="caption" color="text.disabled" noWrap>
            {stateLabel(track)}
          </Typography>
        </Box>
      </ListItemButton>
    </ListItem>
  );
}
