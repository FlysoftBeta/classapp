import React, { useEffect, useRef, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import InputBase from "@mui/material/InputBase";
import Paper from "@mui/material/Paper";
import SearchIcon from "@mui/icons-material/Search";
import {
  refreshMediaConfig,
  refreshMediaPlaylists,
  refreshMediaQueue,
  searchMedia,
} from "@/client/interact/media";
import { useMediaStore } from "@/client/interact/mediaStore";
import type { MediaPlayerApi } from "@/client/hooks/useMediaPlayer";
import { flexGap } from "@/client/lib/css";
import { MediaSearchPopover } from "./MediaSearchPopover";

export function MediaView({
  playerApi,
  onBack,
}: {
  playerApi: MediaPlayerApi;
  onBack?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [searchAnchorEl, setSearchAnchorEl] = useState<HTMLElement | null>(
    null,
  );
  const searchFormRef = useRef<HTMLFormElement | null>(null);
  const searchLoading = useMediaStore((state) => state.searchLoading);

  useEffect(() => {
    void refreshMediaQueue();
    void refreshMediaPlaylists();
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
        p: 2,
        ...flexGap(2, "column"),
        overflow: "hidden",
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
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          pb: 8,
        }}
      >
        <Paper
          component="form"
          ref={searchFormRef}
          onSubmit={handleSearch}
          elevation={3}
          sx={{
            width: "100%",
            maxWidth: 560,
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

      <MediaSearchPopover
        anchorEl={searchAnchorEl}
        query={submittedQuery}
        playerApi={playerApi}
        onClose={() => setSearchAnchorEl(null)}
      />
    </Box>
  );
}
