import React, { useEffect } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import Typography from "@mui/material/Typography";
import MusicNoteIcon from "@mui/icons-material/MusicNote";
import { useApplicationStore } from "@/client/interact/appStore";
import {
  refreshMediaConfig,
  refreshMediaPlaylists,
  refreshMediaQueue,
} from "@/client/interact/media";
import { useMediaStore } from "@/client/interact/mediaStore";
import { playlistCoverUrl } from "../media/coverUrl";
import { SidebarSection } from "./SidebarSection";

export function MediaSection({
  online,
  onOpenMedia,
  onOpenPlaylist,
  expanded,
  onExpandedChange,
}: {
  online: boolean;
  onOpenMedia: () => void;
  onOpenPlaylist: (playlistId: string) => void;
  expanded: boolean;
  onExpandedChange: (value: boolean) => void;
}) {
  const queue = useMediaStore((state) => state.queue);
  const playlists = useMediaStore((state) => state.playlists);
  const token = useApplicationStore((state) => state.token);

  useEffect(() => {
    void refreshMediaQueue();
    void refreshMediaPlaylists();
    void refreshMediaConfig();
  }, []);

  return (
    <SidebarSection
      title="音乐"
      scrollable
      flexWeight={1}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
    >
      <Button fullWidth variant="outlined" onClick={onOpenMedia}>
        搜索音乐
      </Button>
      <Typography variant="caption" color="text.disabled" sx={{ mt: 1, px: 1 }}>
        歌单 {playlists.length} 个 · 队列 {queue?.items.length ?? 0} 首
      </Typography>
      {playlists.length === 0 ? (
        <Box sx={{ p: 1 }}>
          <Typography variant="caption" color="text.disabled">
            还没有歌单。搜索音乐后点击曲目右侧的歌单按钮创建。
          </Typography>
        </Box>
      ) : (
        <List dense disablePadding>
          {playlists.map((playlist) => {
            const coverUrl = playlistCoverUrl(playlist.cover_track_id, token);
            return (
              <ListItemButton
                key={playlist.id}
                onClick={() => onOpenPlaylist(playlist.id)}
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
                      mr: 1,
                      flexShrink: 0,
                    }}
                  />
                ) : (
                  <Box
                    sx={{
                      width: 40,
                      height: 40,
                      borderRadius: 1.5,
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
                <ListItemText
                  primary={playlist.title}
                  secondary={`${playlist.track_count} 首 · 缓存 ${playlist.retention_days} 天`}
                  primaryTypographyProps={{ noWrap: true }}
                  secondaryTypographyProps={{ noWrap: true }}
                />
              </ListItemButton>
            );
          })}
        </List>
      )}
      {!online && (
        <Box sx={{ p: 1 }}>
          <Typography variant="caption" color="text.disabled">
            离线时仅可播放已缓存曲目
          </Typography>
        </Box>
      )}
    </SidebarSection>
  );
}
