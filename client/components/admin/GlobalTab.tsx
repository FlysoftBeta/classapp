import { adminFetchConfig, adminUpdateConfig } from "@/client/api/admin";
import {
  mediaAdminUpdateConfig,
  mediaFetchConfig,
} from "@/client/api/media";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import FormControlLabel from "@mui/material/FormControlLabel";
import Slider from "@mui/material/Slider";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useCallback, useEffect, useState } from "react";

export function GlobalTab({
  canManageLocks,
  canPublishAnnouncement,
  canManageMedia,
}: {
  canManageLocks: boolean;
  canPublishAnnouncement: boolean;
  canManageMedia: boolean;
}) {
  const [idleLock, setIdleLock] = useState(false);
  const [systemLocked, setSystemLocked] = useState(false);
  const [cfgLoading, setCfgLoading] = useState(true);
  const [announcementContent, setAnnouncementContent] = useState("");
  const [cfgSaving, setCfgSaving] = useState(false);
  const [cfgMsg, setCfgMsg] = useState("");
  const [maxVolume, setMaxVolume] = useState(1);
  const [evictionDays, setEvictionDays] = useState(7);

  const fetchConfig = useCallback(async () => {
    setCfgLoading(true);
    const d = await adminFetchConfig();
    if (d) {
      setIdleLock(!!d.idle_lock_enabled);
      setSystemLocked(!!d.system_locked);
      setAnnouncementContent(d.announcement_content);
    }
    if (canManageMedia) {
      try {
        const media = await mediaFetchConfig();
        setMaxVolume(media.max_volume);
        setEvictionDays(media.eviction_days);
      } catch {
        // Keep the previous presentation value; media may be unavailable.
      }
    }
    setCfgLoading(false);
  }, [canManageMedia]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial system tab data
    void fetchConfig();
  }, [fetchConfig]);

  const handleConfigSave = async (updates: {
    idle_lock_enabled?: boolean;
    system_locked?: boolean;
    https_redirect_enabled?: boolean;
    announcement_content?: string;
  }) => {
    setCfgSaving(true);
    setCfgMsg("");
    const { res } = await adminUpdateConfig(updates);
    if (res.ok) {
      if (updates.idle_lock_enabled !== undefined)
        setIdleLock(updates.idle_lock_enabled);
      if (updates.system_locked !== undefined)
        setSystemLocked(updates.system_locked);
      if (updates.announcement_content !== undefined)
        setAnnouncementContent(updates.announcement_content);
      setCfgMsg("已保存");
    } else {
      setCfgMsg("保存失败");
    }
    setCfgSaving(false);
  };

  const saveMedia = async (updates: { max_volume?: number; eviction_days?: number }) => {
    setCfgSaving(true);
    setCfgMsg("");
    try {
      const next = await mediaAdminUpdateConfig(updates);
      setMaxVolume(next.max_volume);
      setEvictionDays(next.eviction_days);
      setCfgMsg("已保存");
    } catch {
      setCfgMsg("保存失败");
    } finally {
      setCfgSaving(false);
    }
  };

  if (cfgLoading) return <CircularProgress size={24} />;

  return (
    <Box>
      {cfgMsg && (
        <Alert
          severity={cfgMsg.includes("失败") ? "error" : "success"}
          onClose={() => setCfgMsg("")}
          sx={{ mb: 2 }}
        >
          {cfgMsg}
        </Alert>
      )}

      {canManageLocks ? (
        <Box>
          <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>
            锁定设置
          </Typography>
          <FormControlLabel
            control={
              <Switch
                checked={idleLock}
                onChange={(e) =>
                  handleConfigSave({ idle_lock_enabled: e.target.checked })
                }
                disabled={cfgSaving}
              />
            }
            label="空闲防偷窥锁定（5 分钟无操作自动锁屏）"
          />
          <Box />
          <FormControlLabel
            control={
              <Switch
                checked={systemLocked}
                onChange={(e) =>
                  handleConfigSave({ system_locked: e.target.checked })
                }
                disabled={cfgSaving}
              />
            }
            label="锁定系统（非管理员无法通过解锁序列进入 App）"
          />
        </Box>
      ) : null}

      {canManageMedia ? (
        <Box sx={{ mt: 3 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
            音乐播放
          </Typography>
          <Typography variant="caption" color="text.secondary">
            最高音量（服务端策略，客户端 WebAudio 管线生效）
          </Typography>
          <Slider
            min={0}
            max={1}
            step={0.05}
            value={maxVolume}
            valueLabelDisplay="auto"
            valueLabelFormat={(value) => `${Math.round(value * 100)}%`}
            onChange={(_event, value) =>
              setMaxVolume(typeof value === "number" ? value : maxVolume)
            }
            onChangeCommitted={(_event, value) =>
              void saveMedia({
                max_volume: typeof value === "number" ? value : maxVolume,
              })
            }
            disabled={cfgSaving}
          />
          <TextField
            label="服务器缓存淘汰天数"
            type="number"
            size="small"
            value={evictionDays}
            onChange={(event) => {
              const value = Number(event.target.value);
              if (Number.isInteger(value) && value > 0) setEvictionDays(value);
            }}
            disabled={cfgSaving}
            sx={{ mt: 1, width: 220 }}
          />
          <Button
            size="small"
            variant="contained"
            disabled={cfgSaving}
            sx={{ display: "block", mt: 1 }}
            onClick={() => void saveMedia({ eviction_days: evictionDays })}
          >
            保存音乐设置
          </Button>
        </Box>
      ) : null}

      {canPublishAnnouncement ? (
        <Box sx={{ mt: 3 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 0.5 }}>
            弹窗型公告
          </Typography>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: "block", mb: 1 }}
          >
            每次保存后，用户都需重新确认。
          </Typography>
          <TextField
            fullWidth
            multiline
            minRows={4}
            label="公告内容"
            value={announcementContent}
            onChange={(event) => setAnnouncementContent(event.target.value)}
            disabled={cfgLoading || cfgSaving}
          />
          <Button
            sx={{ mt: 1 }}
            size="small"
            variant="contained"
            disabled={cfgLoading || cfgSaving}
            onClick={() =>
              void handleConfigSave({
                announcement_content: announcementContent,
              })
            }
          >
            保存并发布公告
          </Button>
        </Box>
      ) : null}
    </Box>
  );
}
