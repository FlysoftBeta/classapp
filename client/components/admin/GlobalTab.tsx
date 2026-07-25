import { adminFetchConfig, adminUpdateConfig } from "@/client/api/admin";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import FormControlLabel from "@mui/material/FormControlLabel";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useCallback, useEffect, useState } from "react";

export function GlobalTab() {
  const [idleLock, setIdleLock] = useState(false);
  const [systemLocked, setSystemLocked] = useState(false);
  const [cfgLoading, setCfgLoading] = useState(true);
  const [announcementContent, setAnnouncementContent] = useState("");
  const [cfgSaving, setCfgSaving] = useState(false);
  const [cfgMsg, setCfgMsg] = useState("");

  const fetchConfig = useCallback(async () => {
    setCfgLoading(true);
    const d = await adminFetchConfig();
    if (d) {
      setIdleLock(!!d.idle_lock_enabled);
      setSystemLocked(!!d.system_locked);
      setAnnouncementContent(d.announcement_content);
    }
    setCfgLoading(false);
  }, []);

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

  if (cfgLoading) return <CircularProgress size={24} />;

  return (
    <Box>
      {cfgMsg && (
        <Alert
          severity={cfgMsg.includes("失败") ? "error" : "success"}
          onClose={() => setCfgMsg("")}
          sx={{ mb: 2 }}
        >
          {" "}
          {cfgMsg}
        </Alert>
      )}

      {/* ── Lock Settings ── */}
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
            void handleConfigSave({ announcement_content: announcementContent })
          }
        >
          保存并发布公告
        </Button>
      </Box>
    </Box>
  );
}
