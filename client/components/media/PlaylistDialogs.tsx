import React, { useState } from "react";
import type {
  MediaListSnapshot,
  MediaPlaylistSummary,
} from "@/shared/media/types";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Slider from "@mui/material/Slider";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import {
  createMediaPlaylist,
  deleteMediaPlaylist,
  updatePlaylistRetention,
} from "@/client/interact/media";

export function CreatePlaylistDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated?: (snapshot: MediaListSnapshot | null) => void;
}) {
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    const value = title.trim();
    if (!value) return;
    setSubmitting(true);
    const snapshot = await createMediaPlaylist(value);
    if (onCreated) {
      onCreated(snapshot);
    } else {
      onClose();
    }
  };

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>新建播放列表</DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          fullWidth
          margin="dense"
          label="播放列表名称"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>取消</Button>
        <Button
          variant="contained"
          disabled={!title.trim() || submitting}
          onClick={() => void submit()}
        >
          创建
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function PlaylistRetentionDialog({
  playlist,
  onClose,
}: {
  playlist: MediaPlaylistSummary;
  onClose: () => void;
}) {
  const [days, setDays] = useState(playlist.retention_days);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setSubmitting(true);
    await updatePlaylistRetention(playlist.id, days);
    onClose();
  };

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>缓存保留天数</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {playlist.title} · 已缓存曲目将在最近一次播放后保留 {days} 天
        </Typography>
        <Slider
          min={1}
          max={365}
          step={1}
          value={days}
          onChange={(_event, value) =>
            setDays(typeof value === "number" ? value : days)
          }
          valueLabelDisplay="auto"
          aria-label="缓存保留天数"
        />
        <Typography variant="caption" color="text.disabled">
          1–365 天
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>取消</Button>
        <Button
          variant="contained"
          disabled={submitting}
          onClick={() => void submit()}
        >
          保存
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function DeletePlaylistDialog({
  playlist,
  onClose,
  onDeleted,
}: {
  playlist: MediaPlaylistSummary;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setSubmitting(true);
    await deleteMediaPlaylist(playlist.id);
    if (onDeleted) onDeleted();
    else onClose();
  };

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>删除播放列表</DialogTitle>
      <DialogContent>
        <Typography>
          确定删除「{playlist.title}」吗？其中的 {playlist.track_count}{" "}
          首曲目不会被删除。
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>取消</Button>
        <Button
          color="error"
          variant="contained"
          disabled={submitting}
          onClick={() => void submit()}
        >
          删除
        </Button>
      </DialogActions>
    </Dialog>
  );
}
