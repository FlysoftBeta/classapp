import React, { useEffect, useState } from "react";
import IconButton from "@mui/material/IconButton";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import SettingsIcon from "@mui/icons-material/Settings";
import PushPinIcon from "@mui/icons-material/PushPin";
import NotificationsOffIcon from "@mui/icons-material/NotificationsOff";
import NotificationsIcon from "@mui/icons-material/Notifications";
import DownloadIcon from "@mui/icons-material/Download";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import Slider from "@mui/material/Slider";
import Button from "@mui/material/Button";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import type { Conversation } from "@/client/interact/presentation";
import {
  setConversationMuted,
  setConversationPinned,
} from "@/client/interact/conversations";
import { captureDetachedClientIncident } from "@/client/interact/clientIncidents";
import {
  getConversationRetention,
  saveConversationRetention,
  type ConversationDownloadPolicy,
} from "@/client/interact/retention";
import { flexGap } from "@/client/lib/css";
import Tooltip from "@mui/material/Tooltip";
import { taskStore } from "@/client/hooks/useTaskStore";

const DOWNLOAD_POLICIES = ["auto", "week", "half-year"] as const;

export function ConversationSettingsMenu({
  conversation,
  online,
  offlineEnabled,
}: {
  conversation: Conversation;
  online: boolean;
  offlineEnabled: boolean;
}) {
  const [anchor, setAnchor] = useState<null | HTMLElement>(null);
  const [loading, setLoading] = useState(false);
  const pinned = !!conversation.pinned;
  const [mutedOverride, setMutedOverride] = useState<{
    conversationId: string;
    value: boolean;
  } | null>(null);
  const muted =
    mutedOverride?.conversationId === conversation.id
      ? mutedOverride.value
      : !!conversation.muted;
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [policy, setPolicy] = useState<ConversationDownloadPolicy>("auto");

  useEffect(() => {
    void getConversationRetention(conversation).then((value) => {
      setPolicy(value);
    });
  }, [conversation]);

  const saveDownloadPolicy = async () => {
    setDownloadOpen(false);
    taskStore.getState().setOpened(true);
    setPolicy(await saveConversationRetention(conversation, policy, () => {}));
  };

  const handleTogglePin = async () => {
    setLoading(true);
    try {
      await setConversationPinned({
        type: conversation.type,
        id: conversation.id,
        pinned: !pinned,
      });
      setAnchor(null);
    } catch (error) {
      captureDetachedClientIncident("conversation.pin-action", error);
    } finally {
      setLoading(false);
    }
  };

  const handleToggleMute = async () => {
    setLoading(true);
    try {
      await setConversationMuted({
        type: conversation.type,
        id: conversation.id,
        muted: !muted,
      });
      setMutedOverride({ conversationId: conversation.id, value: !muted });
      setAnchor(null);
    } catch (error) {
      captureDetachedClientIncident("conversation.mute-action", error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Tooltip title="对话设置">
        <IconButton size="small" onClick={(e) => setAnchor(e.currentTarget)}>
          <SettingsIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Menu
        anchorEl={anchor}
        open={!!anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
      >
        <MenuItem onClick={handleTogglePin} disabled={loading || !online}>
          <ListItemIcon>
            <PushPinIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText>{pinned ? "取消置顶" : "置顶对话"}</ListItemText>
        </MenuItem>
        <MenuItem onClick={handleToggleMute} disabled={loading}>
          <ListItemIcon>
            {muted ? (
              <NotificationsIcon fontSize="small" />
            ) : (
              <NotificationsOffIcon fontSize="small" />
            )}
          </ListItemIcon>
          <ListItemText>{muted ? "取消静音" : "静音对话"}</ListItemText>
        </MenuItem>
        {offlineEnabled && (
          <MenuItem
            onClick={() => {
              setAnchor(null);
              setDownloadOpen(true);
            }}
            disabled={loading}
          >
            <ListItemIcon>
              <DownloadIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>离线下载</ListItemText>
          </MenuItem>
        )}
      </Menu>
      <Dialog
        open={downloadOpen}
        onClose={() => !loading && setDownloadOpen(false)}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>对话离线策略</DialogTitle>
        <DialogContent>
          <Box sx={{ px: 1.5, mt: 2 }}>
            <Typography variant="body2" gutterBottom>
              按消息发送时间保留
            </Typography>
            <Slider
              value={DOWNLOAD_POLICIES.indexOf(policy)}
              min={0}
              max={2}
              step={1}
              marks={[
                { value: 0, label: "自动" },
                { value: 1, label: "一周" },
                { value: 2, label: "半年" },
              ]}
              onChange={(_, value) =>
                setPolicy(DOWNLOAD_POLICIES[value as number])
              }
            />
          </Box>
          {!online && policy !== "auto" && (
            <Typography
              variant="caption"
              color="warning.main"
              sx={{ display: "block", mt: 1 }}
            >
              已保存，将在恢复连接后自动下载；现有缓存仍可使用。
            </Typography>
          )}
          <Box
            sx={{
              display: "flex",
              justifyContent: "flex-end",
              ...flexGap(1),
              mt: 2,
            }}
          >
            <Button onClick={() => setDownloadOpen(false)} disabled={loading}>
              取消
            </Button>
            <Button
              variant="contained"
              onClick={saveDownloadPolicy}
              disabled={loading}
            >
              保存并下载
            </Button>
          </Box>
        </DialogContent>
      </Dialog>
    </>
  );
}
