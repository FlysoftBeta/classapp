import React, { useState } from "react";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Typography from "@mui/material/Typography";
import PlaylistAddIcon from "@mui/icons-material/PlaylistAdd";
import AddIcon from "@mui/icons-material/Add";
import MusicNoteIcon from "@mui/icons-material/MusicNote";
import type { MediaListView } from "@/shared/media/types";
import { addTrackToPlaylist } from "@/client/interact/media";
import { useApplicationStore } from "@/client/interact/appStore";
import { useMediaStore } from "@/client/interact/mediaStore";
import { playlistCoverUrl } from "./coverUrl";
import { CreatePlaylistDialog } from "./PlaylistDialogs";

export function AddToPlaylistButton({
  trackId,
  excludePlaylistId,
}: {
  trackId: string;
  excludePlaylistId?: string;
}) {
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const playlists = useMediaStore((state) => state.playlists);
  const token = useApplicationStore((state) => state.token);

  const addTo = (playlistId: string) => {
    setAnchorEl(null);
    void addTrackToPlaylist(playlistId, trackId);
  };

  const handleCreated = (snapshot: MediaListView | null) => {
    setCreateOpen(false);
    if (snapshot) void addTrackToPlaylist(snapshot.list.id, trackId);
  };

  return (
    <>
      <IconButton
        edge="end"
        size="small"
        title="加入歌单"
        aria-label="加入歌单"
        onClick={(event) => {
          event.stopPropagation();
          setAnchorEl(event.currentTarget);
        }}
      >
        <PlaylistAddIcon fontSize="small" />
      </IconButton>
      <Menu
        anchorEl={anchorEl}
        open={anchorEl !== null}
        onClose={() => setAnchorEl(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{
          paper: {
            sx: { width: 260, maxWidth: "calc(100vw - 32px)", maxHeight: 360 },
          },
        }}
      >
        {playlists.length === 0 ? (
          <MenuItem disabled>
            <MusicNoteIcon fontSize="small" sx={{ mr: 1 }} />
            还没有歌单
          </MenuItem>
        ) : (
          playlists.map((playlist) => {
            const coverUrl = playlistCoverUrl(playlist.cover_track_id, token);
            return (
              <MenuItem
                key={playlist.id}
                disabled={playlist.id === excludePlaylistId}
                onClick={() => addTo(playlist.id)}
              >
                {coverUrl ? (
                  <Box
                    component="img"
                    alt=""
                    src={coverUrl}
                    sx={{
                      width: 28,
                      height: 28,
                      borderRadius: 1,
                      objectFit: "cover",
                      mr: 1,
                      flexShrink: 0,
                    }}
                  />
                ) : (
                  <MusicNoteIcon fontSize="small" sx={{ mr: 1 }} />
                )}
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="body2" noWrap>
                    {playlist.title}
                  </Typography>
                  <Typography variant="caption" color="text.disabled">
                    {playlist.track_count} 首
                  </Typography>
                </Box>
                {playlist.id === excludePlaylistId && (
                  <Typography variant="caption" color="text.disabled">
                    已在其中
                  </Typography>
                )}
              </MenuItem>
            );
          })
        )}
        <Divider />
        <MenuItem
          onClick={() => {
            setAnchorEl(null);
            setCreateOpen(true);
          }}
        >
          <AddIcon fontSize="small" sx={{ mr: 1 }} />
          新建歌单
        </MenuItem>
      </Menu>
      {createOpen && (
        <CreatePlaylistDialog
          onClose={() => setCreateOpen(false)}
          onCreated={handleCreated}
        />
      )}
    </>
  );
}
