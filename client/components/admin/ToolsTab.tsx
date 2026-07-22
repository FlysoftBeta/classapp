import React, { useState } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import Alert from "@mui/material/Alert";
import Stack from "@mui/material/Stack";
import { adminRunTool } from "@/client/api/admin";

export function ToolsTab() {
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (action: "kill-wps" | "shutdown", label: string) => {
    if (action === "shutdown" && !confirm("确认立即关闭计算机？")) return;
    setBusy(action);
    setMsg("");
    setErr("");
    const { res, data } = await adminRunTool(action);
    setBusy(null);
    if (res.ok) {
      setMsg(data.message || `${label}命令已发送`);
    } else {
      setErr(data.error || `${label}失败`);
    }
  };

  return (
    <Box>
      <Typography variant="body2" color="red" sx={{ mb: 2 }}>
        谨慎使用！
      </Typography>
      <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
        <Button
          variant="outlined"
          disabled={busy !== null}
          onClick={() => run("kill-wps", "关闭 WPS")}
        >
          {busy === "kill-wps" ? "执行中…" : "关闭 WPS"}
        </Button>
        <Button
          variant="outlined"
          color="error"
          disabled={busy !== null}
          onClick={() => run("shutdown", "关机")}
        >
          {busy === "shutdown" ? "执行中…" : "关机"}
        </Button>
      </Stack>
      {msg && (
        <Alert severity="success" sx={{ mt: 2 }}>
          {msg}
        </Alert>
      )}
      {err && (
        <Alert severity="error" sx={{ mt: 2 }}>
          {err}
        </Alert>
      )}
    </Box>
  );
}
