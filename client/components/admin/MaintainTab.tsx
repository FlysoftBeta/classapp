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
import TextField from "@mui/material/TextField";
import DeleteIcon from "@mui/icons-material/Delete";
import BackupIcon from "@mui/icons-material/Backup";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import { flexGap } from "@/client/lib/css";
import {
  formatDeviceDate,
  formatDeviceDateTime,
} from "@/client/lib/deviceTime";
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
  adminCheckCloudUpdate,
  adminInstallCloudUpdate,
} from "@/client/api/admin";
import { formatBytes } from "@/shared/bytes";
import type { ActionData } from "@/shared/protocol/actions";
import { AdminDataGrid, type AdminGridColumn } from "./AdminDataGrid";
import { SelectionActionBar, SelectionActionIcon } from "./SelectionActionBar";

type BackupFile = ActionData<"adminFetchBackupsAction">["backups"][number];
type UpdateStatus = ActionData<"adminFetchUpdateStatusAction">;
type HttpsStatus = ActionData<"adminFetchHttpsStatusAction">;

const RESTART_POLL_MS = 3_000;
const RESTART_WAIT_MS = 120_000;

export function MaintainTab({ token }: { token: string }) {
  const [httpsRedirect, setHttpsRedirect] = useState(false);
  const [cloudDeploy, setCloudDeploy] = useState(false);
  const [autoCheck, setAutoCheck] = useState(false);
  const [manifestUrl, setManifestUrl] = useState("");
  const [cfgLoading, setCfgLoading] = useState(true);
  const [cfgSaving, setCfgSaving] = useState(false);
  const [cfgMsg, setCfgMsg] = useState("");

  const [backups, setBackups] = useState<BackupFile[]>([]);
  const [backupsLoading, setBackupsLoading] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const [selectedBackupNames, setSelectedBackupNames] = useState<Set<string>>(
    new Set(),
  );

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
      setCloudDeploy(d.cloud_deploy_enabled);
      setAutoCheck(d.update_auto_check);
      setManifestUrl(d.update_manifest_url);
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
    cloud_deploy_enabled?: boolean;
    update_auto_check?: boolean;
    update_manifest_url?: string;
  }) => {
    setCfgSaving(true);
    setCfgMsg("");
    const { res, data } = await adminUpdateConfig(updates);
    if (res.ok) {
      if (updates.https_redirect_enabled !== undefined) {
        setHttpsRedirect(updates.https_redirect_enabled);
        void fetchHttpsStatus();
      }
      if ("cloud_deploy_enabled" in data) {
        setCloudDeploy(data.cloud_deploy_enabled);
        setAutoCheck(data.update_auto_check);
        setManifestUrl(data.update_manifest_url);
      }
      setCfgMsg("已保存");
    } else {
      setCfgMsg(`保存失败：${"error" in data ? data.error : "请求失败"}`);
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
  const handleDeleteSelectedBackups = async () => {
    if (!confirm(`确认删除选中的 ${selectedBackupNames.size} 份备份？`)) return;
    await Promise.all([...selectedBackupNames].map(adminDeleteBackup));
    setSelectedBackupNames(new Set());
    await fetchBackups();
  };
  const backupColumns: AdminGridColumn<BackupFile>[] = [
    {
      id: "name",
      label: "文件名",
      width: 360,
      pinned: "start",
      hideable: false,
      render: (backup) => backup.name,
      longText: (backup) => backup.name,
    },
    {
      id: "size",
      label: "大小",
      width: 130,
      render: (backup) => formatBytes(backup.size),
    },
    {
      id: "created",
      label: "时间",
      width: 180,
      render: (backup) => formatDeviceDateTime(backup.created_at),
    },
    {
      id: "actions",
      label: "操作",
      width: 130,
      pinned: "end",
      hideable: false,
      render: (backup) => (
        <Box sx={{ display: "flex", alignItems: "center" }}>
          <Button
            size="small"
            onClick={() => handleDownloadBackup(backup.name)}
          >
            下载
          </Button>
          <IconButton
            size="small"
            color="error"
            onClick={() => void handleDeleteBackup(backup.name)}
          >
            <DeleteIcon fontSize="small" />
          </IconButton>
        </Box>
      ),
    },
  ];

  const finishDeploy = (status: UpdateStatus | null, message: string) => {
    if (status) setUpdateStatus(status);
    setDeploying(false);
    setDeployMsg(message);
  };

  const startRestartPoll = () => {
    const startedAt = Date.now();
    const poll = setInterval(async () => {
      try {
        const status = await adminFetchUpdateStatus();
        if (!status) return;
        if (status.pending) {
          clearInterval(poll);
          finishDeploy(status, "");
          return;
        }
        if (Date.now() - startedAt >= RESTART_WAIT_MS) {
          clearInterval(poll);
          finishDeploy(
            status,
            status.disabled
              ? "当前环境已禁用在线更新"
              : "服务器已恢复，但未检测到待确认更新",
          );
        }
      } catch {
        /* not ready yet */
      }
    }, RESTART_POLL_MS);
  };

  const beginRestartWait = () => {
    setDeployFile(null);
    setDeployMsg("服务器正在重启，请稍候…");
    startRestartPoll();
  };

  const handleDeployTransportFailure = async () => {
    try {
      const status = await adminFetchUpdateStatus();
      if (status?.pending) {
        finishDeploy(status, "");
        setDeployFile(null);
        return;
      }
      if (status && !status.pending) {
        finishDeploy(status, "部署失败：连接中断，服务器仍在运行");
        return;
      }
    } catch {
      /* server unreachable — likely restarting */
    }
    beginRestartWait();
  };

  const handleCloudCheck = async () => {
    setUpdateStatusLoading(true);
    setDeployMsg("");
    const { res, data } = await adminCheckCloudUpdate();
    if (!res.ok) {
      setDeployMsg(`检查失败：${"error" in data ? data.error : "请求失败"}`);
    }
    await fetchUpdateStatus();
  };

  const handleCloudInstall = async () => {
    if (!confirm("确认下载并安装这个云端版本？安装后仍需在 3 分钟内确认。")) {
      return;
    }
    setDeploying(true);
    setDeployMsg("正在下载并校验云端更新…");
    try {
      const { res, data } = await adminInstallCloudUpdate();
      if (!res.ok) {
        setDeployMsg(`安装失败：${"error" in data ? data.error : "请求失败"}`);
        setDeploying(false);
        await fetchUpdateStatus();
        return;
      }
      beginRestartWait();
    } catch {
      await handleDeployTransportFailure();
    }
  };

  const handleDeploy = async () => {
    if (!deployFile) return;
    setDeploying(true);
    setDeployMsg("");
    try {
      const res = await adminDeployPackage(token, deployFile);
      if (res.ok) {
        beginRestartWait();
        return;
      }
      const d = await res.json().catch(() => ({ error: "请求失败" }));
      finishDeploy(null, d.error || "部署失败");
    } catch {
      await handleDeployTransportFailure();
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
                      ? `${formatDeviceDate(
                          httpsStatus.certificate.not_before,
                        )} — ${formatDeviceDate(
                          httpsStatus.certificate.not_after,
                        )}`
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
        ) : (
          <AdminDataGrid
            rows={backups}
            columns={backupColumns}
            rowKey={(backup) => backup.name}
            height={Math.min(360, 44 * Math.max(backups.length, 3) + 44)}
            empty="暂无备份"
            selection={{
              selectedKeys: selectedBackupNames,
              onChange: (keys) =>
                setSelectedBackupNames(new Set([...keys].map(String))),
            }}
            bulkActionBar={
              selectedBackupNames.size ? (
                <SelectionActionBar
                  label={`已选 ${selectedBackupNames.size} 份备份`}
                  onClear={() => setSelectedBackupNames(new Set())}
                >
                  <SelectionActionIcon
                    label="删除备份"
                    color="error"
                    onClick={() => void handleDeleteSelectedBackups()}
                  >
                    <DeleteIcon fontSize="small" />
                  </SelectionActionIcon>
                </SelectionActionBar>
              ) : null
            }
          />
        )}
      </Box>

      {/* ── Update Manager ── */}
      <Box sx={{ mt: 3 }}>
        <Typography variant="subtitle2" sx={{ mb: 1, fontWeight: 600 }}>
          云端部署
        </Typography>
        <Box sx={{ display: "flex", ...flexGap(1), alignItems: "flex-start" }}>
          <TextField
            label="Manifest 链接"
            value={manifestUrl}
            onChange={(event) => setManifestUrl(event.target.value)}
            placeholder="https://…/manifest.json"
            size="small"
            fullWidth
            disabled={cfgSaving || !!updateStatus?.disabled}
          />
          <Button
            variant="outlined"
            onClick={() =>
              void handleConfigSave({ update_manifest_url: manifestUrl.trim() })
            }
            disabled={cfgSaving || !!updateStatus?.disabled}
          >
            保存链接
          </Button>
        </Box>
        <Box sx={{ display: "flex", ...flexGap(2), flexWrap: "wrap", mt: 1 }}>
          <FormControlLabel
            control={
              <Switch
                checked={cloudDeploy}
                disabled={cfgSaving || !!updateStatus?.disabled}
                onChange={(event) => {
                  const enabled = event.target.checked;
                  void handleConfigSave(
                    enabled
                      ? {
                          update_manifest_url: manifestUrl.trim(),
                          cloud_deploy_enabled: true,
                        }
                      : {
                          cloud_deploy_enabled: false,
                          update_auto_check: false,
                        },
                  );
                }}
              />
            }
            label="云端部署"
          />
          <FormControlLabel
            control={
              <Switch
                checked={autoCheck}
                disabled={cfgSaving || !cloudDeploy || !!updateStatus?.disabled}
                onChange={(event) => {
                  const enabled = event.target.checked;
                  void handleConfigSave(
                    enabled
                      ? { update_auto_check: true }
                      : { update_auto_check: false },
                  );
                }}
              />
            }
            label="自动检查"
          />
          <Button
            size="small"
            variant="outlined"
            onClick={() => void handleCloudCheck()}
            disabled={
              !cloudDeploy ||
              updateStatusLoading ||
              !!updateStatus?.disabled ||
              !!updateStatus?.pending
            }
          >
            {updateStatus?.cloud_checking ? "检查中…" : "立即检查"}
          </Button>
          <Button
            size="small"
            variant="contained"
            onClick={() => void handleCloudInstall()}
            disabled={
              deploying ||
              !updateStatus?.cloud_update_available ||
              !!updateStatus?.pending
            }
          >
            {updateStatus?.cloud_installing ? "安装中…" : "安装云端更新"}
          </Button>
        </Box>
        {updateStatus && !updateStatus.disabled && (
          <Alert
            severity={updateStatus.cloud_last_error ? "error" : "info"}
            sx={{ mt: 1 }}
          >
            {updateStatus.cloud_installing
              ? "正在下载并安装云端更新…"
              : updateStatus.cloud_checking
                ? "正在检查云端更新…"
                : updateStatus.cloud_last_error
                  ? `最近检查失败：${updateStatus.cloud_last_error}`
                  : updateStatus.cloud_latest_build_id
                    ? `云端版本：${updateStatus.cloud_latest_build_id}${
                        updateStatus.cloud_update_available
                          ? "（有可用更新）"
                          : "（已是当前版本）"
                      }`
                    : "尚未检查云端版本"}
            {updateStatus.cloud_last_checked_at &&
              `；检查时间：${formatDeviceDateTime(
                updateStatus.cloud_last_checked_at,
                true,
              )}`}
          </Alert>
        )}
      </Box>
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
