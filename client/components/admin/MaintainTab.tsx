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
import { flexGap } from "@/client/lib/css";
import {
  adminBackupDownloadUrl,
  adminFetchConfig,
  adminUpdateConfig,
  adminFetchBackups,
  adminCreateBackup,
  adminDeleteBackup,
  adminFetchUpdateStatus,
  adminFetchHttpsStatus,
  adminDeployPackage,
  adminConfirmUpdate,
  adminRollback,
} from "@/client/api/admin";
import { formatBytes } from "@/shared/bytes";
import type { ActionData } from "@/shared/protocol/actions";

type BackupFile = ActionData<"adminFetchBackupsAction">["backups"][number];
type UpdateStatus = ActionData<"adminFetchUpdateStatusAction">;
type HttpsStatus = ActionData<"adminFetchHttpsStatusAction">;

export function MaintainTab({ token }: { token: string }) {
  const [httpsRedirect, setHttpsRedirect] = useState(false);
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
  const [httpsStatus, setHttpsStatus] = useState<HttpsStatus | null>(null);

  const fetchConfig = useCallback(async () => {
    setCfgLoading(true);
    const d = await adminFetchConfig();
    if (d) {
      setHttpsRedirect(!!d.https_redirect_enabled);
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

  const fetchHttpsStatus = useCallback(async () => {
    const d = await adminFetchHttpsStatus();
    if (d) setHttpsStatus(d);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial system tab data
    void fetchConfig();
    void fetchBackups();
    void fetchUpdateStatus();
    void fetchHttpsStatus();
  }, [fetchConfig, fetchBackups, fetchUpdateStatus, fetchHttpsStatus]);

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
      if (updates.https_redirect_enabled !== undefined) {
        setHttpsRedirect(updates.https_redirect_enabled);
        void fetchHttpsStatus();
      }
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
      {/* ── HTTPS Upgrade ── */}
      <Box>
        <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>
          HTTPS 升级
        </Typography>
        {!httpsStatus ? (
          <CircularProgress size={20} />
        ) : (
          <>
            <Alert
              severity={
                httpsStatus.certificate.valid
                  ? httpsStatus.certificate.days_remaining !== null &&
                    httpsStatus.certificate.days_remaining <= 30
                    ? "warning"
                    : "success"
                  : "error"
              }
              sx={{ mb: 1.5 }}
            >
              {httpsStatus.certificate.valid
                ? `证书有效，距离过期还有 ${httpsStatus.certificate.days_remaining} 天`
                : httpsStatus.certificate.error || "证书无效"}
            </Alert>
            <Table size="small" sx={{ mb: 1.5 }}>
              <TableBody>
                <TableRow>
                  <TableCell>预期域名</TableCell>
                  <TableCell sx={{ fontFamily: "monospace" }}>
                    {httpsStatus.domain || "未配置"}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>HTTPS 监听端口</TableCell>
                  <TableCell>
                    {httpsStatus.secure_ports.join(", ") || "未配置"}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>证书有效期</TableCell>
                  <TableCell>
                    {httpsStatus.certificate.not_before &&
                    httpsStatus.certificate.not_after
                      ? `${new Date(
                          httpsStatus.certificate.not_before,
                        ).toLocaleDateString()} — ${new Date(
                          httpsStatus.certificate.not_after,
                        ).toLocaleDateString()}`
                      : "—"}
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>根 CA</TableCell>
                  <TableCell>
                    {httpsStatus.certificate.root_subject || "未提供根证书"}
                    {httpsStatus.certificate.root_compatible === true
                      ? "（兼容检查通过）"
                      : httpsStatus.certificate.root_compatible === false
                        ? "（生效日期晚于 2020 年）"
                        : ""}
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>

            <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>
              路由器 / 内网 DNS 主机记录
            </Typography>
            <Typography variant="caption" color="text.secondary">
              请在实际负责内网解析的路由器或 DNS 服务器中配置。
            </Typography>
            {httpsStatus.dns_records.length === 0 ? (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                未检测到可用的局域网地址
              </Typography>
            ) : (
              <Table size="small" sx={{ mt: 0.5, mb: 1 }}>
                <TableHead>
                  <TableRow>
                    <TableCell>类型</TableCell>
                    <TableCell>主机名</TableCell>
                    <TableCell>目标地址</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {httpsStatus.dns_records.map((record) => (
                    <TableRow key={`${record.type}-${record.value}`}>
                      <TableCell>{record.type}</TableCell>
                      <TableCell sx={{ fontFamily: "monospace" }}>
                        {record.name}
                      </TableCell>
                      <TableCell sx={{ fontFamily: "monospace" }}>
                        {record.value}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}

            <FormControlLabel
              control={
                <Switch
                  checked={httpsRedirect}
                  onChange={(event) => {
                    const enabled = event.target.checked;
                    if (
                      enabled &&
                      !confirm(
                        "301 会被浏览器长期缓存，即使以后关闭此开关，已访问过的客户端也可能继续跳转。确认开启？",
                      )
                    )
                      return;
                    void handleConfigSave({
                      https_redirect_enabled: enabled,
                    });
                  }}
                  disabled={cfgSaving || !httpsStatus.configured}
                />
              }
              label="将 HTTP shell 入口永久重定向到 HTTPS"
            />
            {!httpsStatus.configured && (
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: "block" }}
              >
                部署包尚未包含完整的域名、证书、私钥与 HTTPS 监听端口。
              </Typography>
            )}
          </>
        )}
      </Box>

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
              <Box sx={{ display: "flex", ...flexGap(1) }}>
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
                ...flexGap(1),
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
