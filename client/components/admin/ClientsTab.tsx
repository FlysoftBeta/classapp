import { useEffect, useState } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import CircularProgress from "@mui/material/CircularProgress";
import Chip from "@mui/material/Chip";
import Switch from "@mui/material/Switch";
import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import TextField from "@mui/material/TextField";
import Alert from "@mui/material/Alert";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Autocomplete from "@mui/material/Autocomplete";
import Tooltip from "@mui/material/Tooltip";
import DeleteIcon from "@mui/icons-material/Delete";
import LockIcon from "@mui/icons-material/Lock";
import LockOpenIcon from "@mui/icons-material/LockOpen";
import EditIcon from "@mui/icons-material/Edit";
import BookmarkAddIcon from "@mui/icons-material/BookmarkAdd";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import TuneIcon from "@mui/icons-material/Tune";
import {
  type AdminClientRecord as ClientRecord,
  adminFetchClients,
  adminFetchConfig,
  adminSearchUsers,
  adminUpdateConfig,
  adminWhitelistCurrentClient,
  adminMutateClients,
} from "@/client/api/admin";
import { isFuture, formatRemaining } from "@/shared/time";
import { useActionQuery } from "@/client/hooks/useActionQuery";
import { formatDeviceDateTime } from "@/client/lib/deviceTime";
import { AdminDataGrid, type AdminGridColumn } from "./AdminDataGrid";
import { HelpSection } from "@/client/components/shared/HelpTip";
import { DialogTitleWithHelp } from "@/client/components/shared/HelpTip";
import {
  BATCH_INCREMENTAL_HELP,
  IncrementalCheckbox,
  type IncrementalBoolean,
} from "./IncrementalField";
import { SelectionActionBar, SelectionActionIcon } from "./SelectionActionBar";

type IdentityMethod = "mac" | "ip" | "user_agent";
type UserOption = { id: string; label: string };
type Feedback = { severity: "success" | "warning" | "error"; text: string };

export function ClientsTab() {
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState("");
  const [whitelistEnabled, setWhitelistEnabled] = useState(false);
  const [methods, setMethods] = useState<IdentityMethod[]>([
    "mac",
    "user_agent",
  ]);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [editing, setEditing] = useState<ClientRecord | null>(null);
  const [editRemark, setEditRemark] = useState("");
  const [editWhitelisted, setEditWhitelisted] = useState(false);
  const [boundUser, setBoundUser] = useState<UserOption | null>(null);
  const [userOptions, setUserOptions] = useState<UserOption[]>([]);
  const [saving, setSaving] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchAccessOpen, setBatchAccessOpen] = useState(false);
  const [batchWhitelisted, setBatchWhitelisted] =
    useState<IncrementalBoolean>("unchanged");
  const [batchSaving, setBatchSaving] = useState(false);

  const { data, loading, reload } = useActionQuery<{
    clients: ClientRecord[];
    total: number;
  }>(() => adminFetchClients(offset, query), [offset, query]);

  useEffect(() => {
    void adminFetchConfig().then((config) => {
      if (!config) return;
      setWhitelistEnabled(config.whitelist_enabled);
      setMethods(config.identity_methods);
    });
  }, []);

  const saveConfig = async (
    updates: Parameters<typeof adminUpdateConfig>[0],
  ) => {
    setFeedback(null);
    const { res, data: config } = await adminUpdateConfig(updates);
    if (!res.ok || !("whitelist_enabled" in config)) {
      setFeedback({ severity: "error", text: "设置保存失败" });
      return false;
    }
    setWhitelistEnabled(config.whitelist_enabled);
    setMethods(config.identity_methods);
    reload();
    return true;
  };

  const toggleMethod = (method: IdentityMethod) => {
    const next = methods.includes(method)
      ? methods.filter((item) => item !== method)
      : [...methods, method];
    if (next.length === 0) {
      setFeedback({ severity: "warning", text: "至少选择一种客户端标识字段" });
      return;
    }
    void saveConfig({ identity_methods: next });
  };

  const handleWhitelistModeChange = async (enabled: boolean) => {
    if (enabled) {
      const { res, data: result } = await adminWhitelistCurrentClient();
      if (!res.ok) {
        setFeedback({
          severity: "error",
          text: `无法开启白名单模式：${"error" in result ? result.error : "当前客户端授权失败"}`,
        });
        return;
      }
    }
    if (await saveConfig({ whitelist_enabled: enabled })) {
      setFeedback({
        severity: "success",
        text: enabled
          ? "白名单模式已开启，当前客户端已保留并授权"
          : "白名单模式已关闭",
      });
    }
  };

  const handleKeepCurrent = async () => {
    const { res, data: result } = await adminWhitelistCurrentClient();
    if (!res.ok) {
      setFeedback({
        severity: "error",
        text: "error" in result ? result.error : "当前客户端授权失败",
      });
      return;
    }
    setFeedback({ severity: "success", text: "当前客户端已保留并加入白名单" });
    reload();
  };

  const handlePromote = async (client: ClientRecord) => {
    try {
      await adminMutateClients([{ id: client.id, promote: true }]);
      setFeedback({ severity: "success", text: `已保留客户端 ${client.id}` });
    } catch {
      setFeedback({ severity: "error", text: "保留客户端失败" });
    }
    reload();
  };

  const handleDelete = async (client: ClientRecord) => {
    const label = client.remark || client.id;
    if (!confirm(`确认删除客户端「${label}」？相关会话也会被清除。`)) return;
    try {
      await adminMutateClients([{ id: client.id, delete: true }]);
    } catch {
      setFeedback({ severity: "error", text: "客户端删除失败" });
    }
    reload();
  };

  const handleToggleLock = async (client: ClientRecord) => {
    try {
      await adminMutateClients([
        { id: client.id, locked: !client.konami_locked },
      ]);
    } catch {
      setFeedback({ severity: "error", text: "锁定状态更新失败" });
    }
    reload();
  };

  const searchUsers = async (value: string) => {
    const result = await adminSearchUsers(value);
    setUserOptions(
      (result?.users ?? []).map((user) => ({
        id: user.id,
        label: `@${user.handle} · ${user.username}`,
      })),
    );
  };

  const openEdit = (client: ClientRecord) => {
    setEditing(client);
    setEditRemark(client.remark);
    setEditWhitelisted(client.whitelisted);
    const current = client.bound_user_id
      ? {
          id: client.bound_user_id,
          label: `@${client.bound_user_handle ?? client.bound_user_id}`,
        }
      : null;
    setBoundUser(current);
    setUserOptions(current ? [current] : []);
    void searchUsers(client.bound_user_handle ?? "");
  };

  const saveClient = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      await adminMutateClients([
        {
          id: editing.id,
          remark: editRemark,
          whitelisted: editWhitelisted,
          bound_user_id: boundUser?.id ?? null,
        },
      ]);
    } catch (error) {
      setSaving(false);
      setFeedback({
        severity: "error",
        text: error instanceof Error ? error.message : "客户端属性保存失败",
      });
      return;
    }
    setSaving(false);
    setEditing(null);
    setFeedback({ severity: "success", text: "客户端属性已保存" });
    reload();
  };

  const selectedClients = (data?.clients ?? []).filter((client) =>
    selectedIds.has(client.id),
  );
  const whitelistAggregate: "enabled" | "disabled" | "mixed" =
    selectedClients.every((client) => client.whitelisted)
      ? "enabled"
      : selectedClients.every((client) => !client.whitelisted)
        ? "disabled"
        : "mixed";
  const applyBatchAccess = async () => {
    if (batchWhitelisted === "unchanged") return;
    setBatchSaving(true);
    try {
      await adminMutateClients(
        selectedClients.map((record) => ({
          id: record.id,
          ...(!record.persistent ? { promote: true } : {}),
          whitelisted: batchWhitelisted === "enabled",
        })),
      );
      setBatchAccessOpen(false);
      setBatchWhitelisted("unchanged");
      setSelectedIds(new Set());
      reload();
    } finally {
      setBatchSaving(false);
    }
  };
  const batchSetLock = async (locked: boolean) => {
    await adminMutateClients(
      selectedClients.map((record) => ({ id: record.id, locked })),
    );
    setSelectedIds(new Set());
    reload();
  };
  const batchPromote = async () => {
    const changes = selectedClients
      .filter((record) => !record.persistent)
      .map((record) => ({ id: record.id, promote: true }));
    if (!changes.length) {
      setFeedback({ severity: "warning", text: "所选客户端均已持久化" });
      return;
    }
    await adminMutateClients(changes);
    setSelectedIds(new Set());
    reload();
  };
  const batchDelete = async () => {
    if (
      !confirm(
        `确认删除选中的 ${selectedClients.length} 个客户端？相关会话也会被清除。`,
      )
    )
      return;
    await adminMutateClients(
      selectedClients.map((record) => ({ id: record.id, delete: true })),
    );
    setSelectedIds(new Set());
    reload();
  };

  const columns: AdminGridColumn<ClientRecord>[] = [
    {
      id: "id",
      label: "客户端 ID",
      width: 280,
      pinned: "start",
      hideable: false,
      render: (client) => (
        <Box sx={{ display: "flex", alignItems: "center", minWidth: 0 }}>
          <Typography
            variant="body2"
            sx={{
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              fontFamily: "monospace",
              fontWeight: 600,
            }}
          >
            {client.id}
          </Typography>
          <Tooltip title="复制 ID">
            <IconButton
              size="small"
              onClick={(event) => {
                event.stopPropagation();
                void navigator.clipboard.writeText(client.id);
              }}
            >
              <ContentCopyIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </Tooltip>
        </Box>
      ),
      longText: (client) => client.id,
    },
    {
      id: "remark",
      label: "备注",
      width: 180,
      render: (client) => client.remark || "—",
      longText: (client) => client.remark,
    },
    {
      id: "state",
      label: "准入状态",
      width: 210,
      render: (client) => (
        <Box sx={{ display: "flex", gap: 0.5 }}>
          <Chip
            size="small"
            label={client.persistent ? "持久" : "临时"}
            color={client.persistent ? "primary" : "default"}
            variant={client.persistent ? "filled" : "outlined"}
          />
          {client.persistent ? (
            <Chip
              size="small"
              label={client.whitelisted ? "白名单" : "未授权"}
              color={client.whitelisted ? "success" : "default"}
            />
          ) : null}
        </Box>
      ),
    },
    {
      id: "last_seen",
      label: "最近活跃",
      width: 180,
      render: (client) =>
        client.last_seen ? formatDeviceDateTime(client.last_seen) : "尚未活跃",
    },
    {
      id: "mac",
      label: "MAC",
      width: 190,
      render: (client) => client.mac || "—",
      longText: (client) => client.mac,
    },
    {
      id: "ips",
      label: "IP",
      width: 260,
      render: (client) => client.ips.join(", ") || "—",
      longText: (client) => client.ips.join("\n"),
    },
    {
      id: "user_agent",
      label: "User Agent",
      width: 520,
      render: (client) => client.user_agent || "—",
      longText: (client) => client.user_agent,
    },
    {
      id: "sessions",
      label: "活跃会话",
      width: 260,
      render: (client) =>
        client.active_sessions
          ? `${client.active_sessions} 个 · ${client.session_users}`
          : "无活跃会话",
      longText: (client) => client.session_users,
    },
    {
      id: "binding",
      label: "绑定用户",
      width: 220,
      render: (client) =>
        client.bound_user_id
          ? `@${client.bound_user_handle ?? client.bound_user_id}`
          : "未绑定",
      longText: (client) => client.bound_user_id,
    },
    {
      id: "protection",
      label: "登录保护",
      width: 240,
      render: (client) => {
        if (client.throttled_until && isFuture(client.throttled_until)) {
          return `登录节流 · 剩余 ${formatRemaining(client.throttled_until)}`;
        }
        if (client.konami_locked) return "已锁定";
        return client.attempts > 0 ? `${client.attempts} 次失败` : "正常";
      },
    },
    {
      id: "actions",
      label: "操作",
      width: 150,
      pinned: "end",
      hideable: false,
      render: (client) => (
        <Box sx={{ display: "flex" }}>
          {!client.persistent ? (
            <Tooltip title="转为持久客户端">
              <IconButton
                size="small"
                color="primary"
                onClick={() => void handlePromote(client)}
              >
                <BookmarkAddIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          ) : (
            <Tooltip title="编辑属性">
              <IconButton size="small" onClick={() => openEdit(client)}>
                <EditIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
          <Tooltip title={client.konami_locked ? "解锁" : "锁定"}>
            <IconButton
              size="small"
              onClick={() => void handleToggleLock(client)}
            >
              {client.konami_locked ? (
                <LockOpenIcon fontSize="small" />
              ) : (
                <LockIcon fontSize="small" />
              )}
            </IconButton>
          </Tooltip>
          <Tooltip title="删除">
            <IconButton
              size="small"
              color="error"
              onClick={() => void handleDelete(client)}
            >
              <DeleteIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
      ),
    },
  ];

  return (
    <Box>
      <Box
        sx={{
          mb: 2,
          p: 2.25,
          border: "1px solid",
          borderColor: "divider",
          borderRadius: 2,
        }}
      >
        <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
          客户端访问控制
        </Typography>
        <HelpSection label="Authentication Flow 与持久化机制">
          <Typography variant="body2" color="text.secondary" component="div">
            浏览器首次连接时，服务端按下方启用的标识字段组合匹配客户端记录；匹配结果是准入身份，不等同于用户账号。新记录先是临时客户端：没有会话且连续一天未活跃后会被清理。转为持久客户端后，记录、备注、白名单状态与用户绑定才会长期保留。
            <br />
            <br />
            白名单模式关闭时，已识别的客户端均可进入登录流程；开启时，只有“持久且已加入白名单”、并且当前标识仍属于该记录的客户端可以进入。开启前系统会先保留并授权当前客户端，避免管理员立即锁在系统之外。绑定用户是登录后的第二层约束：它限制此客户端能登录哪个账号，并会清理不符合绑定的既有会话。
            <br />
            <br />
            MAC 通常稳定但可能被网络设备隐藏；IP 可能因
            DHCP、漫游或代理变化；User Agent
            辨识度较弱且会随升级改变。启用多个字段会提高区分能力，也可能让环境变化后的设备产生新记录，因此应按实际网络拓扑选择。
          </Typography>
        </HelpSection>

        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: "block", mt: 2 }}
        >
          客户端标识方式
        </Typography>
        <Box>
          {(
            [
              ["mac", "MAC"],
              ["user_agent", "User Agent"],
              ["ip", "IP"],
            ] as const
          ).map(([value, label]) => (
            <FormControlLabel
              key={value}
              control={
                <Checkbox
                  size="small"
                  checked={methods.includes(value)}
                  onChange={() => toggleMethod(value)}
                />
              }
              label={label}
            />
          ))}
        </Box>
        <FormControlLabel
          control={
            <Switch
              checked={whitelistEnabled}
              onChange={(event) =>
                void handleWhitelistModeChange(event.target.checked)
              }
            />
          }
          label="白名单模式（谨慎使用）"
        />
        <Box>
          <Button
            size="small"
            variant="outlined"
            onClick={() => void handleKeepCurrent()}
          >
            保留并授权当前客户端
          </Button>
        </Box>
      </Box>

      {feedback && (
        <Alert
          severity={feedback.severity}
          onClose={() => setFeedback(null)}
          sx={{ mb: 2 }}
        >
          {feedback.text}
        </Alert>
      )}

      <TextField
        size="small"
        label="搜索客户端"
        placeholder="客户端 ID、备注或绑定用户"
        value={query}
        onChange={(event) => {
          setOffset(0);
          setQuery(event.target.value);
        }}
        sx={{ width: { xs: "100%", sm: 360 }, mb: 2 }}
      />

      {loading ? (
        <Box sx={{ py: 4, textAlign: "center" }}>
          <CircularProgress size={28} />
        </Box>
      ) : (
        <AdminDataGrid
          rows={data?.clients ?? []}
          columns={columns}
          rowKey={(client) => client.id}
          empty="没有匹配的客户端"
          selection={{
            selectedKeys: selectedIds,
            onChange: (keys) => setSelectedIds(new Set([...keys].map(String))),
          }}
          bulkActionBar={
            selectedClients.length ? (
              <SelectionActionBar
                label={`已选 ${selectedClients.length} 个客户端`}
                onClear={() => setSelectedIds(new Set())}
              >
                <SelectionActionIcon
                  label="配置准入"
                  onClick={() => setBatchAccessOpen(true)}
                >
                  <TuneIcon fontSize="small" />
                </SelectionActionIcon>
                <SelectionActionIcon
                  label="转为持久客户端"
                  onClick={() => void batchPromote()}
                >
                  <BookmarkAddIcon fontSize="small" />
                </SelectionActionIcon>
                <SelectionActionIcon
                  label="锁定"
                  onClick={() => void batchSetLock(true)}
                >
                  <LockIcon fontSize="small" />
                </SelectionActionIcon>
                <SelectionActionIcon
                  label="解锁"
                  onClick={() => void batchSetLock(false)}
                >
                  <LockOpenIcon fontSize="small" />
                </SelectionActionIcon>
                <SelectionActionIcon
                  label="删除客户端"
                  color="error"
                  onClick={() => void batchDelete()}
                >
                  <DeleteIcon fontSize="small" />
                </SelectionActionIcon>
              </SelectionActionBar>
            ) : null
          }
        />
      )}

      <Dialog
        open={batchAccessOpen}
        onClose={() => !batchSaving && setBatchAccessOpen(false)}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitleWithHelp help={BATCH_INCREMENTAL_HELP}>
          批量配置客户端准入
        </DialogTitleWithHelp>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            临时客户端在授权时会自动转为持久客户端。
          </Typography>
          <IncrementalCheckbox
            label="加入白名单"
            value={batchWhitelisted}
            aggregate={whitelistAggregate}
            onChange={setBatchWhitelisted}
          />
        </DialogContent>
        <DialogActions>
          <Button
            disabled={batchSaving}
            onClick={() => setBatchAccessOpen(false)}
          >
            取消
          </Button>
          <Button
            variant="contained"
            disabled={batchSaving || batchWhitelisted === "unchanged"}
            onClick={() => void applyBatchAccess()}
          >
            应用到 {selectedClients.length} 个客户端
          </Button>
        </DialogActions>
      </Dialog>

      {data && data.total > 50 && (
        <Box
          sx={{
            mt: 1.5,
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
          }}
        >
          <Button
            size="small"
            disabled={offset === 0}
            onClick={() => setOffset((value) => Math.max(0, value - 50))}
          >
            上一页
          </Button>
          <Typography variant="caption" sx={{ mx: 1 }}>
            {offset + 1}–{Math.min(offset + 50, data.total)} / {data.total}
          </Typography>
          <Button
            size="small"
            disabled={offset + 50 >= data.total}
            onClick={() => setOffset((value) => value + 50)}
          >
            下一页
          </Button>
        </Box>
      )}

      <Dialog
        open={!!editing}
        onClose={() => !saving && setEditing(null)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>客户端属性</DialogTitle>
        <DialogContent>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: "block", mt: -1, mb: 2, fontFamily: "monospace" }}
          >
            {editing?.id}
          </Typography>
          <TextField
            autoFocus
            fullWidth
            label="备注"
            placeholder="例如：三楼教室平板"
            value={editRemark}
            onChange={(event) => setEditRemark(event.target.value)}
            inputProps={{ maxLength: 100 }}
            sx={{ mb: 2 }}
          />
          <Autocomplete
            options={userOptions}
            value={boundUser}
            onChange={(_, value) => setBoundUser(value)}
            onInputChange={(_, value, reason) => {
              if (reason === "input") void searchUsers(value);
            }}
            filterOptions={(options) => options}
            isOptionEqualToValue={(option, value) => option.id === value.id}
            renderInput={(params) => (
              <TextField
                {...params}
                label="绑定用户（可选）"
                placeholder="输入 ID 或显示名称搜索"
              />
            )}
          />
          <Typography variant="caption" color="text.secondary">
            绑定后仅该用户可在此客户端登录；现有的其他用户会话将被清除。
          </Typography>
          <Box sx={{ mt: 2 }}>
            <FormControlLabel
              control={
                <Switch
                  checked={editWhitelisted}
                  onChange={(event) => setEditWhitelisted(event.target.checked)}
                />
              }
              label="加入白名单"
            />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button disabled={saving} onClick={() => setEditing(null)}>
            取消
          </Button>
          <Button
            variant="contained"
            disabled={saving}
            onClick={() => void saveClient()}
          >
            {saving ? <CircularProgress size={18} /> : "保存"}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
