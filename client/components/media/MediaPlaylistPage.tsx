import React, { useEffect, useState } from "react";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import IconButton from "@mui/material/IconButton";
import List from "@mui/material/List";
import Typography from "@mui/material/Typography";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import DeleteIcon from "@mui/icons-material/Delete";
import MusicNoteIcon from "@mui/icons-material/MusicNote";
import ScheduleIcon from "@mui/icons-material/Schedule";
import type { MediaPlayerApi } from "@/client/hooks/useMediaPlayer";
import {
  addTrackToQueue,
  openMediaPlaylist,
  removeTrackFromPlaylist,
} from "@/client/interact/media";
import { useApplicationStore } from "@/client/interact/appStore";
import { useMediaStore } from "@/client/interact/mediaStore";
import { flexGap } from "@/client/lib/css";
import { playlistCoverUrl } from "./coverUrl";
import {
  DeletePlaylistDialog,
  PlaylistRetentionDialog,
} from "./PlaylistDialogs";
import { TrackRow } from "./TrackRow";

export function MediaPlaylistPage({
  playlistId,
  playerApi,
  onBack,
}: {
  playlistId: string;
  playerApi: MediaPlayerApi;
  onBack: () => void;
}) {
  const currentPlaylist = useMediaStore((state) => state.currentPlaylist);
  const token = useApplicationStore((state) => state.token);
  const [loadedPlaylistId, setLoadedPlaylistId] = useState<string | null>(null);
  const [retentionOpen, setRetentionOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const playlist =
    currentPlaylist?.list.id === playlistId ? currentPlaylist : null;
  const coverUrl = playlistCoverUrl(
    playlist?.list.cover_track_id ?? null,
    token,
  );
  const loading = loadedPlaylistId !== playlistId;

  useEffect(() => {
    let cancelled = false;
    void openMediaPlaylist(playlistId).then(() => {
      if (!cancelled) setLoadedPlaylistId(playlistId);
    });
    return () => {
      cancelled = true;
    };
  }, [playlistId]);

  return (
    <Box
      sx={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          ...flexGap(1),
          px: 1.5,
          py: 1,
          borderBottom: "1px solid",
          borderColor: "divider",
          flexShrink: 0,
        }}
      >
        <IconButton
          size="small"
          title="返回音乐库"
          aria-label="返回音乐库"
          onClick={onBack}
        >
          <ArrowBackIcon fontSize="small" />
        </IconButton>
        {coverUrl ? (
          <Box
            component="img"
            alt=""
            src={coverUrl}
            sx={{
              width: 44,
              height: 44,
              borderRadius: 1.5,
              objectFit: "cover",
              flexShrink: 0,
            }}
          />
        ) : (
          <Box
            sx={{
              width: 44,
              height: 44,
              borderRadius: 1.5,
              bgcolor: "action.hover",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <MusicNoteIcon fontSize="small" color="disabled" />
          </Box>
        )}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="subtitle1" fontWeight={700} noWrap>
            {playlist?.list.title ?? "播放列表"}
          </Typography>
          <Typography variant="caption" color="text.disabled">
            {playlist
              ? `${playlist.items.length} 首 · 缓存 ${playlist.list.retention_days} 天`
              : "正在加载…"}
          </Typography>
        </Box>
        {playlist && (
          <>
            <IconButton
              size="small"
              title="设置缓存天数"
              aria-label="设置缓存天数"
              onClick={() => setRetentionOpen(true)}
            >
              <ScheduleIcon fontSize="small" />
            </IconButton>
            <IconButton
              size="small"
              title="删除歌单"
              aria-label="删除歌单"
              onClick={() => setDeleteOpen(true)}
            >
              <DeleteIcon fontSize="small" />
            </IconButton>
          </>
        )}
      </Box>

      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", p: 2, pb: 14 }}>
        {loading && !playlist ? (
          <Box
            sx={{
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <CircularProgress size={28} />
          </Box>
        ) : !playlist ? (
          <Box
            sx={{
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "text.disabled",
            }}
          >
            <Typography variant="body2">无法加载播放列表</Typography>
          </Box>
        ) : playlist.items.length === 0 ? (
          <Box
            sx={{
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "text.disabled",
            }}
          >
            <Typography variant="body2">歌单里还没有曲目</Typography>
          </Box>
        ) : (
          <List dense disablePadding>
            {playlist.items.map((item) => {
              const track = playlist.tracks.find(
                (value) => value.id === item.track_id,
              );
              if (!track) return null;
              return (
                <TrackRow
                  key={`${playlist.list.id}:${item.position}`}
                  track={track}
                  playerApi={playerApi}
                  playlistId={playlistId}
                  onQueueAdd={(id) => void addTrackToQueue(id)}
                  onRemove={(id) =>
                    void removeTrackFromPlaylist(playlistId, id)
                  }
                  removeTitle="从歌单移除"
                />
              );
            })}
          </List>
        )}
      </Box>

      {retentionOpen && playlist && (
        <PlaylistRetentionDialog
          playlist={playlist.list}
          onClose={() => setRetentionOpen(false)}
        />
      )}
      {deleteOpen && playlist && (
        <DeletePlaylistDialog
          playlist={playlist.list}
          onClose={() => setDeleteOpen(false)}
          onDeleted={onBack}
        />
      )}
    </Box>
  );
}
