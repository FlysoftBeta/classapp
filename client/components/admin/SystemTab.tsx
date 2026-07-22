import { useState, useEffect, useCallback, useRef } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import IconButton from "@mui/material/IconButton";
import Switch from "@mui/material/Switch";
import FormControlLabel from "@mui/material/FormControlLabel";
import Alert from "@mui/material/Alert";
import CircularProgress from "@mui/material/CircularProgress";
import LinearProgress from "@mui/material/LinearProgress";
import DeleteIcon from "@mui/icons-material/Delete";
import BackupIcon from "@mui/icons-material/Backup";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import {
  adminBackupDownloadUrl,
  adminFetchConfig,
  adminUpdateConfig,
  adminFetchBackups,
  adminCreateBackup,
  adminDeleteBackup,
  adminFetchUpdateStatus,
  adminDeployPackage,
  adminConfirmUpdate,
  adminRollback,
} from "@/client/api/admin";
import { formatBytes } from "@/shared/bytes";
import type { ActionData } from "@/shared/protocol/actions";

type BackupFile = ActionData<"adminFetchBackupsAction">["backups"][number];
type UpdateStatus = ActionData<"adminFetchUpdateStatusAction">;

export function SystemTab({ token }: { token: string }) {
  const [idleLock, setIdleLock] = useState(false);
  const [systemLocked, setSystemLocked] = useState(false);
  const [cfgLoading, setCfgLoading] = useState(true);
  const [cfgSaving, setCfgSaving] = useState(false);
  const [cfgMsg, setCfgMsg] = useState("");

  const [backups, setBackups] = useState<BackupFile[]>([]);
  const [backupsLoading, setBackupsLoading] = useState(false);
  const [backingUp, setBackingUp] = useState(false);

  const [deployFile, setDeployFile] = useState<File | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [deployMsg, setDeployMsg] = useState("");
  const deployFileRef = useRef<HTMLInputElement>(null);

  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [updateStatusLoading, setUpdateStatusLoading] = useState(false);

  const fetchConfig = useCallback(async () => {
    setCfgLoading(true);
    const d = await adminFetchConfig();
    if (d) {
      setIdleLock(!!d.idle_lock_enabled);
      setSystemLocked(!!d.system_locked);
    }
    setCfgLoading(false);
  }, []);

  const fetchBackups = useCallback(async () => {
    setBackupsLoading(true);
    const d = await adminFetchBackups();
    if (d) {
      setBackups(d.backups || []);
    }
    setBackupsLoading(false);
  }, []);

  const fetchUpdateStatus = useCallback(async () => {
    setUpdateStatusLoading(true);
    const d = await adminFetchUpdateStatus();
    if (d) setUpdateStatus(d);
    setUpdateStatusLoading(false);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial system tab data
    void fetchConfig();
    void fetchBackups();
    void fetchUpdateStatus();
  }, [fetchConfig, fetchBackups, fetchUpdateStatus]);

  const handleConfigSave = async (updates: {
    idle_lock_enabled?: boolean;
    system_locked?: boolean;
  }) => {
    setCfgSaving(true);
    setCfgMsg("");
    const { res } = await adminUpdateConfig(updates);
    if (res.ok) {
      if (updates.idle_lock_enabled !== undefined)
        setIdleLock(updates.idle_lock_enabled);
      if (updates.system_locked !== undefined)
        setSystemLocked(updates.system_locked);
      setCfgMsg("已保存");
    } else {
      setCfgMsg("保存失败");
    }
    setCfgSaving(false);
  };

  const handleCreateBackup = async () => {
    setBackingUp(true);
    const result = await adminCreateBackup();
    setBackingUp(false);
    if (result.res.ok) {
      setBackups(("backups" in result.data && result.data.backups) || []);
    }
  };

  const handleDownloadBackup = (name: string) => {
    window.open(adminBackupDownloadUrl(token, name), "_blank");
  };

  const handleDeleteBackup = async (name: string) => {
    if (!confirm(`确认删除备份 ${name}？`)) return;
    const res = await adminDeleteBackup(name);
    if (res.ok) fetchBackups();
  };

  const startRestartPoll = () => {
    const poll = setInterval(async () => {
      try {
        const d = await adminFetchUpdateStatus();
        if (d) {
          clearInterval(poll);
          setUpdateStatus(d);
          setDeploying(false);
        }
      } catch {
        /* not ready yet */
      }
    }, 3000);
  };

  const handleDeploy = async () => {
    if (!deployFile) return;
    setDeploying(true);
    setDeployMsg("");
    try {
      const res = await adminDeployPackage(token, deployFile);
      if (res.ok) {
        setDeployMsg("服务器正在重启，请稍候…");
        setDeployFile(null);
        startRestartPoll();
      } else {
        const d = await res.json().catch(() => ({ error: "请求失败" }));
        setDeployMsg(d.error || "部署失败");
        setDeploying(false);
      }
    } catch {
      setDeployMsg("服务器正在重启，请稍候…");
      setDeployFile(null);
      startRestartPoll();
    }
  };

  const handleConfirmUpdate = async () => {
    const { res } = await adminConfirmUpdate();
    if (res.ok) {
      setUpdateStatus(null);
      setDeployMsg("更新已确认！");
    }
  };

  const handleRollback = async () => {
    if (!confirm("确认立即回滚到上一个版本？")) return;
    try {
      const { res, data } = await adminRollback();
      if (res.ok) {
        setUpdateStatus(null);
        setDeployMsg("服务器正在回滚并重启，请稍候…");
        const poll = setInterval(async () => {
          try {
            const d = await adminFetchUpdateStatus();
            if (d) {
              clearInterval(poll);
              setUpdateStatus(d);
              setDeployMsg("回滚完成");
            }
          } catch {
            /* server still restarting */
          }
        }, 3000);
      } else {
        setDeployMsg(("error" in data && data.error) || "回滚失败，请手动操作");
      }
    } catch {
      // Connection reset while the server restarts is expected
      setDeployMsg("服务器正在回滚并重启，请稍候…");
    }
  };

  if (cfgLoading) return <CircularProgress size={24} />;

  return (
    <Box>
      {/* ── Lock Settings ── */}
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
      {cfgMsg && (
        <Typography
          variant="caption"
          color={cfgMsg.includes("失败") ? "error" : "success.main"}
          sx={{ display: "block", mt: 0.5 }}
        >
          {cfgMsg}
        </Typography>
      )}

      {/* ── Database Backups ── */}
      <Box sx={{ mt: 3 }}>
        <Box sx={{ display: "flex", alignItems: "center", mb: 1 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 600, flex: 1 }}>
            数据库备份
          </Typography>
          <Button
            startIcon={<BackupIcon />}
            size="small"
            variant="outlined"
            onClick={handleCreateBackup}
            disabled={backingUp}
          >
            {backingUp ? "备份中…" : "立即备份"}
          </Button>
        </Box>
        {backupsLoading ? (
          <CircularProgress size={20} />
        ) : backups.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            暂无备份
          </Typography>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>文件名</TableCell>
                <TableCell>大小</TableCell>
                <TableCell>时间</TableCell>
                <TableCell align="right">操作</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {backups.map((b) => (
                <TableRow key={b.name}>
                  <TableCell sx={{ fontSize: 12, fontFamily: "monospace" }}>
                    {b.name}
                  </TableCell>
                  <TableCell sx={{ fontSize: 12 }}>
                    {formatBytes(b.size)}
                  </TableCell>
                  <TableCell sx={{ fontSize: 12 }}>
                    {b.created_at.slice(0, 16)}
                  </TableCell>
                  <TableCell align="right">
                    <Button
                      size="small"
                      onClick={() => handleDownloadBackup(b.name)}
                    >
                      下载
                    </Button>
                    <IconButton
                      size="small"
                      color="error"
                      onClick={() => handleDeleteBackup(b.name)}
                    >
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Box>

      {/* ── Update Manager ── */}
      {updateStatus && !updateStatus.disabled ? (
        <>
          {updateStatus?.pending && (
            <Box
              sx={{
                mt: 3,
                p: 2,
                border: "1px solid",
                borderColor: "warning.main",
                borderRadius: 1,
                bgcolor: "warning.light",
              }}
            >
              <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
                ⚠ 待确认更新
              </Typography>
              <Typography variant="body2" sx={{ mb: 1 }}>
                更新已应用，请在{" "}
                <strong>{updateStatus.seconds_remaining} 秒</strong>
                内确认，否则将自动回滚（launcher 同步在 3 分钟超时回滚）。
              </Typography>
              {!updateStatusLoading && updateStatus.timeout_seconds && (
                <LinearProgress
                  variant="determinate"
                  value={
                    (1 -
                      updateStatus.seconds_remaining /
                        updateStatus.timeout_seconds) *
                    100
                  }
                  sx={{ mb: 1.5 }}
                />
              )}
              <Box sx={{ display: "flex", gap: 1 }}>
                <Button
                  variant="contained"
                  color="success"
                  size="small"
                  onClick={handleConfirmUpdate}
                >
                  确认更新成功
                </Button>
                <Button
                  variant="outlined"
                  color="error"
                  size="small"
                  onClick={handleRollback}
                >
                  立即回滚
                </Button>
              </Box>
            </Box>
          )}

          {/* ── Deploy ── */}
          <Box sx={{ mt: 3 }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
              上传更新包
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
              上传 deploy.zip（需包含
              client/、server/、shell.html、node_modules/），服务器将自动重启并应用更新。更新前会自动备份数据库；回滚时应用与数据库将一并还原。请在
              3 分钟内确认更新成功，否则 launcher 与 update manager
              同步自动回滚。
            </Typography>
            <input
              ref={deployFileRef}
              type="file"
              accept=".zip"
              style={{ display: "none" }}
              onChange={(e) => setDeployFile(e.target.files?.[0] ?? null)}
            />
            <Box
              sx={{
                display: "flex",
                gap: 1,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <Button
                startIcon={<CloudUploadIcon />}
                variant="outlined"
                size="small"
                onClick={() => deployFileRef.current?.click()}
              >
                {deployFile ? deployFile.name : "选择 .zip 文件"}
              </Button>
              <Button
                variant="contained"
                size="small"
                onClick={handleDeploy}
                disabled={deploying || !deployFile}
              >
                {deploying ? "正在上传…" : "上传并更新"}
              </Button>
            </Box>
            {deployMsg && (
              <Alert
                severity={deployMsg.includes("失败") ? "error" : "info"}
                sx={{ mt: 1.5 }}
              >
                {deployMsg}
              </Alert>
            )}
          </Box>
        </>
      ) : updateStatus?.disabled ? (
        <Box sx={{ mt: 3 }}>
          <Typography variant="body2" color="text.secondary">
            当前环境已禁用在线更新（测试/开发模式）。数据库备份功能仍可使用。
          </Typography>
        </Box>
      ) : null}
    </Box>
  );
}
