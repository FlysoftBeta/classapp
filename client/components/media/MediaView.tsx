import React, { useEffect, useRef, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import InputBase from "@mui/material/InputBase";
import Paper from "@mui/material/Paper";
import SearchIcon from "@mui/icons-material/Search";
import AddIcon from "@mui/icons-material/Add";
import MusicNoteIcon from "@mui/icons-material/MusicNote";
import {
  refreshMediaConfig,
  refreshMediaLibrary,
  refreshMediaPlaylists,
  refreshMediaQueue,
  searchMedia,
} from "@/client/interact/media";
import { useMediaStore } from "@/client/interact/mediaStore";
import { useApplicationStore } from "@/client/interact/appStore";
import type { MediaPlayerApi } from "@/client/hooks/useMediaPlayer";
import { flexGap } from "@/client/lib/css";
import { AccessibleListRow } from "@/client/components/library/AccessibleListRow";
import { LibrarySection } from "@/client/components/library/LibrarySection";
import { MediaSearchPopover } from "./MediaSearchPopover";
import { TrackRow } from "./TrackRow";
import { playlistCoverUrl } from "./coverUrl";
import { CreatePlaylistDialog } from "./PlaylistDialogs";
import { addTrackToQueue } from "@/client/interact/media";

export function MediaView({
  playerApi,
  onBack,
  onOpenPlaylist,
}: {
  playerApi: MediaPlayerApi;
  onBack?: () => void;
  onOpenPlaylist: (playlistId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [searchAnchorEl, setSearchAnchorEl] = useState<HTMLElement | null>(
    null,
  );
  const [createOpen, setCreateOpen] = useState(false);
  const searchFormRef = useRef<HTMLFormElement | null>(null);
  const searchLoading = useMediaStore((state) => state.searchLoading);
  const recents = useMediaStore((state) => state.libraryRecents);
  const favorites = useMediaStore((state) => state.libraryFavorites);
  const playlists = useMediaStore((state) => state.playlists);
  const token = useApplicationStore((state) => state.token);

  useEffect(() => {
    void refreshMediaQueue();
    void refreshMediaPlaylists();
    void refreshMediaLibrary();
    void refreshMediaConfig();
  }, []);

  const handleSearch = (event: React.FormEvent) => {
    event.preventDefault();
    const value = query.trim();
    if (!value) return;
    setSubmittedQuery(value);
    setSearchAnchorEl(searchFormRef.current);
    void searchMedia(value);
  };

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
          px: 2,
          pt: 2,
          pb: 1,
          display: "flex",
          flexDirection: "column",
          ...flexGap(1.5),
          flexShrink: 0,
        }}
      >
        {onBack && (
          <Button
            variant="text"
            onClick={onBack}
            sx={{ alignSelf: "flex-start" }}
          >
            返回
          </Button>
        )}
        <Paper
          component="form"
          ref={searchFormRef}
          onSubmit={handleSearch}
          elevation={2}
          sx={{
            width: "100%",
            p: "4px 8px",
            display: "flex",
            alignItems: "center",
            borderRadius: 4,
          }}
        >
          <SearchIcon sx={{ color: "text.disabled", mr: 1 }} />
          <InputBase
            sx={{ ml: 1, flex: 1 }}
            placeholder="搜索音乐"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            inputProps={{ "aria-label": "搜索音乐" }}
          />
          <Button
            type="submit"
            variant="contained"
            disabled={searchLoading || !query.trim()}
          >
            搜索
          </Button>
        </Paper>
      </Box>

      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", pb: 10 }}>
        <LibrarySection title="最近播放" empty="还没有播放记录">
          {recents.slice(0, 12).map((track) => (
            <TrackRow
              key={`recent-${track.id}`}
              track={track}
              playerApi={playerApi}
              onQueueAdd={(id) => void addTrackToQueue(id)}
            />
          ))}
        </LibrarySection>
        <LibrarySection title="收藏" empty="还没有收藏曲目">
          {favorites.map((track) => (
            <TrackRow
              key={`fav-${track.id}`}
              track={track}
              playerApi={playerApi}
              onQueueAdd={(id) => void addTrackToQueue(id)}
            />
          ))}
        </LibrarySection>
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            px: 2,
            pt: 1,
          }}
        >
          <Box sx={{ flex: 1 }} />
          <Button
            size="small"
            startIcon={<AddIcon />}
            onClick={() => setCreateOpen(true)}
          >
            新建播放列表
          </Button>
        </Box>
        <LibrarySection title="播放列表" empty="还没有可访问的播放列表">
          {playlists.map((playlist) => (
            <AccessibleListRow
              key={playlist.id}
              title={playlist.title}
              subtitle={`${playlist.track_count} 首`}
              coverUrl={playlistCoverUrl(playlist.cover_track_id, token)}
              icon={<MusicNoteIcon fontSize="small" color="disabled" />}
              onOpen={() => onOpenPlaylist(playlist.id)}
            />
          ))}
        </LibrarySection>
      </Box>

      <MediaSearchPopover
        anchorEl={searchAnchorEl}
        query={submittedQuery}
        playerApi={playerApi}
        onClose={() => setSearchAnchorEl(null)}
      />
      {createOpen && (
        <CreatePlaylistDialog
          onClose={() => setCreateOpen(false)}
          onCreated={(snapshot) => {
            setCreateOpen(false);
            if (snapshot) onOpenPlaylist(snapshot.list.id);
          }}
        />
      )}
    </Box>
  );
}
