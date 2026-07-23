import { useState } from "react";
import Box from "@mui/material/Box";
import BugReportOutlinedIcon from "@mui/icons-material/BugReportOutlined";
import Fab from "@mui/material/Fab";
import FormControlLabel from "@mui/material/FormControlLabel";
import Popover from "@mui/material/Popover";
import Switch from "@mui/material/Switch";
import Typography from "@mui/material/Typography";
import { client } from "@/client/remote/Client";
import { useDebugStore } from "@/client/store/debugStore";

export default function DebugMenu() {
  if (!import.meta.env.DEV) return null;
  return <DebugMenuContents />;
}

function DebugMenuContents() {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [forcedOffline, setForcedOffline] = useState(() =>
    client.isForcedOffline(),
  );
  const showInfiniIds = useDebugStore((state) => state.showInfiniIds);
  const showInfiniLogs = useDebugStore((state) => state.showInfiniLogs);
  const setShowInfiniIds = useDebugStore((state) => state.setShowInfiniIds);
  const setShowInfiniLogs = useDebugStore((state) => state.setShowInfiniLogs);

  const handleForcedOffline = (enabled: boolean) => {
    client.setForcedOffline(enabled);
    setForcedOffline(enabled);
  };

  return (
    <>
      <Fab
        aria-label="打开调试菜单"
        aria-controls={anchor ? "debug-menu" : undefined}
        aria-haspopup="dialog"
        color={forcedOffline ? "warning" : "default"}
        size="small"
        onClick={(event) => setAnchor(event.currentTarget)}
        sx={{
          position: "fixed",
          right: 16,
          bottom: "calc(16px + env(safe-area-inset-bottom, 0px))",
          zIndex: (theme) => theme.zIndex.modal + 1,
        }}
      >
        <BugReportOutlinedIcon fontSize="small" />
      </Fab>

      <Popover
        id="debug-menu"
        open={!!anchor}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "top", horizontal: "right" }}
        transformOrigin={{ vertical: "bottom", horizontal: "right" }}
        slotProps={{ paper: { sx: { width: 280, p: 2, mb: 1 } } }}
      >
        <Typography variant="subtitle1" fontWeight={700}>
          调试菜单
        </Typography>
        <FormControlLabel
          sx={{ mt: 1, ml: 0, width: "100%", justifyContent: "space-between" }}
          labelPlacement="start"
          label={
            <Box>
              <Typography variant="body2">强制离线</Typography>
              <Typography variant="caption" color="text.secondary">
                使用本地缓存并暂停所有远程请求
              </Typography>
            </Box>
          }
          control={
            <Switch
              checked={forcedOffline}
              onChange={(event) => handleForcedOffline(event.target.checked)}
              inputProps={{ "aria-label": "强制离线" }}
            />
          }
        />
        <FormControlLabel
          sx={{ mt: 1, ml: 0, width: "100%", justifyContent: "space-between" }}
          labelPlacement="start"
          label={<Typography variant="body2">显示 Infini ID</Typography>}
          control={
            <Switch
              checked={showInfiniIds}
              onChange={(event) => setShowInfiniIds(event.target.checked)}
              inputProps={{ "aria-label": "显示 Infini ID" }}
            />
          }
        />
        <FormControlLabel
          sx={{ ml: 0, width: "100%", justifyContent: "space-between" }}
          labelPlacement="start"
          label={<Typography variant="body2">显示 Infini 日志</Typography>}
          control={
            <Switch
              checked={showInfiniLogs}
              onChange={(event) => setShowInfiniLogs(event.target.checked)}
              inputProps={{ "aria-label": "显示 Infini 日志" }}
            />
          }
        />
      </Popover>
    </>
  );
}
