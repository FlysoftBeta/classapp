import { useState, type MouseEvent as ReactMouseEvent } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import IconButton from "@mui/material/IconButton";
import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import Popover from "@mui/material/Popover";
import Paper from "@mui/material/Paper";
import Switch from "@mui/material/Switch";
import FormControlLabel from "@mui/material/FormControlLabel";
import Alert from "@mui/material/Alert";
import CircularProgress from "@mui/material/CircularProgress";
import Chip from "@mui/material/Chip";
import Checkbox from "@mui/material/Checkbox";
import DeleteIcon from "@mui/icons-material/Delete";
import EditIcon from "@mui/icons-material/Edit";
import AddIcon from "@mui/icons-material/Add";
import { flexGap } from "@/client/lib/css";
import type { User } from "@/shared/types/api";
import {
  adminFetchUsers,
  adminCreateUser,
  adminUpdateUser,
  adminDeleteUser,
} from "@/client/api/admin";
import {
  adminFetchSelfDisciplineMode,
  adminUpdateSelfDisciplineMode,
} from "@/client/api/words";
import { isFuture } from "@/shared/time";
import {
  DialogTitleWithHelp,
  LabelWithHelp,
} from "@/client/components/shared/HelpTip";
import { useActionQuery } from "@/client/hooks/useActionQuery";
import {
  DEFAULT_FEATURE_MASK,
  hasFeature,
  setFeature,
} from "@/shared/features";
import {
  FeatureGatesPanel,
  aggregateFeatureGateStates,
  applyFeatureGateChanges,
  createUnchangedFeatureGateChanges,
  featureGateChangesFromMask,
  type FeatureGateChange,
} from "./FeatureGatesPanel";
import { MultiSectionDurationPicker } from "./MultiSectionDurationPicker";

export function UsersTab() {
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  const { data, loading, reload } = useActionQuery<{
    users: User[];
    total: number;
  }>(() => adminFetchUsers(q, offset), [q, offset]);

  const [editUser, setEditUser] = useState<User | null>(null);
  const [editHandle, setEditHandle] = useState("");
  const [editUsername, setEditUsername] = useState("");
  const [editFeatureMask, setEditFeatureMask] = useState(DEFAULT_FEATURE_MASK);
  const [editPin, setEditPin] = useState("");
  const [editMuted, setEditMuted] = useState(false);
  const [editMuteDays, setEditMuteDays] = useState(1);
  const [editMuteHours, setEditMuteHours] = useState(0);
  const [editBanned, setEditBanned] = useState(false);
  const [editBanDays, setEditBanDays] = useState(1);
  const [editBanHours, setEditBanHours] = useState(0);
  const [editSelfDiscipline, setEditSelfDiscipline] = useState(false);
  const [editErr, setEditErr] = useState("");
  const [editSaving, setEditSaving] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [newHandle, setNewHandle] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [newPin, setNewPin] = useState("");
  const [newFeatureMask, setNewFeatureMask] = useState(DEFAULT_FEATURE_MASK);
  const [createErr, setCreateErr] = useState("");
  const [creating, setCreating] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchSaving, setBatchSaving] = useState(false);
  const [batchErr, setBatchErr] = useState("");
  const [batchAnchorEl, setBatchAnchorEl] = useState<HTMLElement | null>(null);
  const [batchGateChanges, setBatchGateChanges] = useState(
    createUnchangedFeatureGateChanges,
  );

  const openEdit = async (u: User) => {
    setEditUser(u);
    setEditHandle(u.handle);
    setEditUsername(u.username);
    setEditFeatureMask(u.feature_mask);
    setEditPin("");
    setEditMuted(!!u.is_muted);
    setEditMuteDays(1);
    setEditMuteHours(0);
    setEditBanned(isFuture(u.banned_until));
    setEditBanDays(1);
    setEditBanHours(0);
    setEditErr("");

    const data = await adminFetchSelfDisciplineMode(u.id);
    setEditSelfDiscipline(data.enabled || false);
  };

  const isBanned = (u: User) => isFuture(u.banned_until);

  const handleSaveEdit = async () => {
    if (!editUser) return;
    setEditSaving(true);
    setEditErr("");
    const wasMuted = !!editUser.is_muted;
    const wasBanned = isBanned(editUser);
    const muteHours = editMuteDays * 24 + editMuteHours;
    const banHours = editBanDays * 24 + editBanHours;
    if (
      (!wasMuted && editMuted && muteHours <= 0) ||
      (!wasBanned && editBanned && banHours <= 0)
    ) {
      setEditSaving(false);
      setEditErr("时长不能为 0");
      return;
    }
    const body: Record<string, unknown> = {
      handle: editHandle,
      username: editUsername,
      feature_mask: editFeatureMask,
    };
    if (wasMuted && !editMuted) body.unmute = true;
    if (!wasMuted && editMuted) body.mute_hours = muteHours;
    if (wasBanned && !editBanned) body.unban = true;
    if (!wasBanned && editBanned) body.ban_hours = banHours;
    if (editPin) body.pin = editPin;
    const { res, data } = await adminUpdateUser(editUser.id, body);
    if (!res.ok) {
      setEditSaving(false);
      setEditErr(("error" in data && data.error) || "失败");
      return;
    }

    await adminUpdateSelfDisciplineMode(editUser.id, editSelfDiscipline);

    setEditSaving(false);
    setEditUser(null);
    reload();
  };

  const handleDelete = async (id: string) => {
    if (!confirm("确认删除该干员？")) return;
    await adminDeleteUser(id);
    reload();
  };

  const handleCreate = async () => {
    setCreating(true);
    setCreateErr("");
    const { res, data } = await adminCreateUser({
      handle: newHandle,
      username: newUsername || newHandle,
      pin: newPin,
      feature_mask: newFeatureMask,
    });
    setCreating(false);
    if (!res.ok) {
      setCreateErr(("error" in data && data.error) || "失败");
      return;
    }
    setCreateOpen(false);
    setNewHandle("");
    setNewUsername("");
    setNewPin("");
    setNewFeatureMask(DEFAULT_FEATURE_MASK);
    reload();
  };

  const selectedUsers = (data?.users || []).filter((u) =>
    selectedIds.has(u.id),
  );
  const hasBatchGateChanges = Object.values(batchGateChanges).some(
    (change) => change !== "unchanged",
  );
  const batchGateAggregateStates = aggregateFeatureGateStates(selectedUsers);
  const handleBatchGateChange = (
    gate: keyof typeof batchGateChanges,
    change: FeatureGateChange,
  ) => {
    setBatchErr("");
    setBatchGateChanges((current) => ({ ...current, [gate]: change }));
  };
  const handleApplyBatchGates = async () => {
    if (selectedUsers.length === 0 || !hasBatchGateChanges) return;
    setBatchSaving(true);
    setBatchErr("");
    try {
      const updates = selectedUsers
        .map((user) => ({
          user,
          featureMask: applyFeatureGateChanges(
            user.feature_mask,
            batchGateChanges,
          ),
        }))
        .filter(({ user, featureMask }) => featureMask !== user.feature_mask);
      const results = await Promise.all(
        updates.map(({ user, featureMask }) =>
          adminUpdateUser(user.id, { feature_mask: featureMask }),
        ),
      );
      const failed = results.find(({ res }) => !res.ok);
      if (failed) {
        setBatchErr(
          ("error" in failed.data && failed.data.error) || "应用失败",
        );
      } else {
        setBatchGateChanges(createUnchangedFeatureGateChanges());
        setBatchAnchorEl(null);
      }
      reload();
    } catch (error) {
      setBatchErr(error instanceof Error ? error.message : "应用失败");
    } finally {
      setBatchSaving(false);
    }
  };
  const handleOpenBatchMenu = (event: ReactMouseEvent<HTMLButtonElement>) => {
    setBatchErr("");
    setBatchGateChanges(createUnchangedFeatureGateChanges());
    setBatchAnchorEl(event.currentTarget);
  };
  const handleCloseBatchMenu = () => {
    if (batchSaving) return;
    setBatchAnchorEl(null);
    setBatchErr("");
    setBatchGateChanges(createUnchangedFeatureGateChanges());
  };

  return (
    <Box>
      <Box sx={{ display: "flex", alignItems: "center", mb: 2 }}>
        <TextField
          size="small"
          placeholder="搜索 ID 或名称…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOffset(0);
          }}
          sx={{ flex: 1, mr: 1 }}
        />
        <Button
          startIcon={<AddIcon />}
          variant="contained"
          size="small"
          onClick={() => setCreateOpen(true)}
        >
          新建干员
        </Button>
      </Box>

      {selectedUsers.length > 0 ? (
        <Paper
          variant="outlined"
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            ...flexGap(1),
            px: 1.5,
            py: 0.75,
            mb: 2,
            bgcolor: "action.hover",
          }}
        >
          <Typography variant="body2">
            已选 {selectedUsers.length} 人
          </Typography>
          <Button
            size="small"
            variant="outlined"
            disabled={batchSaving}
            onClick={handleOpenBatchMenu}
          >
            应用…
          </Button>
        </Paper>
      ) : null}

      <Popover
        open={!!batchAnchorEl}
        anchorEl={batchAnchorEl}
        onClose={handleCloseBatchMenu}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{
          paper: {
            sx: { width: 360, maxWidth: "calc(100vw - 32px)", mt: 0.5 },
          },
        }}
      >
        <FeatureGatesPanel
          value={batchGateChanges}
          aggregateValue={batchGateAggregateStates}
          onChange={handleBatchGateChange}
          title={`应用功能权限 · ${selectedUsers.length} 人`}
          description="勾选表示全部启用，半选表示部分启用，未选表示全部禁用。仅改动过的项目会被应用。"
          applying={batchSaving}
          onApply={() => void handleApplyBatchGates()}
          applyDisabled={!hasBatchGateChanges}
          applyLabel="应用"
          error={batchErr}
          embedded
        />
      </Popover>

      {loading ? (
        <CircularProgress size={24} />
      ) : (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell padding="checkbox">
                <Checkbox
                  size="small"
                  checked={
                    (data?.users.length ?? 0) > 0 &&
                    selectedIds.size === data?.users.length
                  }
                  indeterminate={
                    selectedIds.size > 0 &&
                    selectedIds.size < (data?.users.length ?? 0)
                  }
                  onChange={(e) =>
                    setSelectedIds(
                      e.target.checked
                        ? new Set((data?.users || []).map((u) => u.id))
                        : new Set(),
                    )
                  }
                />
              </TableCell>
              <TableCell>@ID</TableCell>
              <TableCell>显示名称</TableCell>
              <TableCell>注册时间</TableCell>
              <TableCell>状态</TableCell>
              <TableCell align="right">操作</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {(data?.users || []).map((u) => (
              <TableRow key={u.id}>
                <TableCell padding="checkbox">
                  <Checkbox
                    size="small"
                    checked={selectedIds.has(u.id)}
                    onChange={(e) =>
                      setSelectedIds((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(u.id);
                        else next.delete(u.id);
                        return next;
                      })
                    }
                  />
                </TableCell>
                <TableCell sx={{ fontFamily: "monospace", fontSize: 12 }}>
                  @{u.handle}
                </TableCell>
                <TableCell>{u.username}</TableCell>
                <TableCell sx={{ fontSize: 12 }}>
                  {u.created_at.slice(0, 16)}
                </TableCell>
                <TableCell>
                  {u.is_muted ? (
                    <Chip
                      label="禁言"
                      size="small"
                      color="warning"
                      sx={{ mr: 0.5 }}
                    />
                  ) : null}
                  {isBanned(u) ? (
                    <Chip label="已封禁" size="small" color="error" />
                  ) : null}
                  {hasFeature(u, "admin") ? (
                    <Chip label="管理员" size="small" color="primary" />
                  ) : null}
                </TableCell>
                <TableCell align="right">
                  <IconButton size="small" onClick={() => openEdit(u)}>
                    <EditIcon fontSize="small" />
                  </IconButton>
                  <IconButton
                    size="small"
                    color="error"
                    onClick={() => handleDelete(u.id)}
                  >
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {data && data.total > 50 && (
        <Box sx={{ mt: 1, display: "flex", alignItems: "center" }}>
          <Button
            size="small"
            disabled={offset === 0}
            onClick={() => setOffset((o) => Math.max(0, o - 50))}
          >
            上一页
          </Button>
          <Typography variant="caption" sx={{ mx: 1 }}>
            {offset + 1}–{Math.min(offset + 50, data.total)} / {data.total}
          </Typography>
          <Button
            size="small"
            disabled={offset + 50 >= data.total}
            onClick={() => setOffset((o) => o + 50)}
          >
            下一页
          </Button>
        </Box>
      )}

      {/* Edit dialog */}
      <Dialog
        open={!!editUser}
        onClose={() => setEditUser(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitleWithHelp help="修改干员的基础信息、角色、PIN、禁言与封禁状态。已生效的禁言或封禁需要先关闭并保存，之后才能重新配置时长。">
          编辑干员
        </DialogTitleWithHelp>
        <DialogContent>
          <TextField
            label={
              <LabelWithHelp
                label="ID（@handle）"
                help="干员唯一公开标识，可用于 @提及与登录定位。"
              />
            }
            fullWidth
            size="small"
            sx={{ mt: 1 }}
            value={editHandle}
            onChange={(e) =>
              setEditHandle(e.target.value.replace(/[^a-zA-Z0-9_]/g, ""))
            }
            inputProps={{ maxLength: 20 }}
          />
          <TextField
            label={
              <LabelWithHelp
                label="显示名称"
                help="对外展示的名称，可任意字符，不参与定位。"
              />
            }
            fullWidth
            size="small"
            sx={{ mt: 1.5 }}
            value={editUsername}
            onChange={(e) => setEditUsername(e.target.value)}
            inputProps={{ maxLength: 30 }}
          />
          <FeatureGatesPanel
            value={featureGateChangesFromMask(editFeatureMask)}
            allowUnchanged={false}
            onChange={(gate, change) =>
              setEditFeatureMask((mask) =>
                setFeature(mask, gate, change === "enabled"),
              )
            }
          />
          <TextField
            label={
              <LabelWithHelp
                label="重置 PIN（留空不变）"
                help="一旦填写并保存，干员所有旧 PIN 立即失效，仅此新 PIN 可用。"
              />
            }
            fullWidth
            size="small"
            sx={{ mt: 1.5 }}
            type="password"
            value={editPin}
            onChange={(e) =>
              setEditPin(e.target.value.replace(/\D/g, "").slice(0, 6))
            }
          />
          <FormControlLabel
            control={
              <Switch
                checked={editMuted}
                onChange={(e) => setEditMuted(e.target.checked)}
              />
            }
            label={
              <LabelWithHelp
                label="禁言"
                help="禁言后干员可登录但无法发送消息。"
              />
            }
            sx={{ mt: 1 }}
          />
          {editUser && editMuted && !editUser.is_muted && (
            <Box sx={{ mt: 0.5, mb: 1.5 }}>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: "block", mb: 1 }}
              >
                禁言时长
              </Typography>
              <MultiSectionDurationPicker
                days={editMuteDays}
                hours={editMuteHours}
                onDaysChange={setEditMuteDays}
                onHoursChange={setEditMuteHours}
              />
            </Box>
          )}
          <FormControlLabel
            control={
              <Switch
                checked={editBanned}
                onChange={(e) => setEditBanned(e.target.checked)}
              />
            }
            label={
              <LabelWithHelp
                label="封禁"
                help="封禁后，该干员所有会话立即失效，直到封禁结束。"
              />
            }
            sx={{ mt: 0.5 }}
          />
          {editUser && editBanned && !isBanned(editUser) && (
            <Box sx={{ mt: 0.5, mb: 1.5 }}>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: "block", mb: 1 }}
              >
                封禁时长
              </Typography>
              <MultiSectionDurationPicker
                days={editBanDays}
                hours={editBanHours}
                onDaysChange={setEditBanDays}
                onHoursChange={setEditBanHours}
              />
            </Box>
          )}
          <FormControlLabel
            control={
              <Switch
                checked={editSelfDiscipline}
                onChange={(e) => setEditSelfDiscipline(e.target.checked)}
              />
            }
            label={
              <LabelWithHelp
                label="自律模式"
                help="开启后，该干员在学习中心启用定时弹窗答题。"
              />
            }
            sx={{ mt: 1 }}
          />

          {editErr && (
            <Alert severity="error" sx={{ mt: 1 }}>
              {editErr}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditUser(null)}>取消</Button>
          <Button
            variant="contained"
            onClick={handleSaveEdit}
            disabled={editSaving}
          >
            保存
          </Button>
        </DialogActions>
      </Dialog>

      {/* Create dialog */}
      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitleWithHelp help="直接创建一个完整账号。如需让对方自行完成 OOBE 设置，请使用「招募干员」（ghost user）。">
          新建干员
        </DialogTitleWithHelp>
        <DialogContent>
          <TextField
            label="ID（@handle，字母/数字/下划线）"
            fullWidth
            size="small"
            sx={{ mt: 1 }}
            value={newHandle}
            onChange={(e) =>
              setNewHandle(e.target.value.replace(/[^a-zA-Z0-9_]/g, ""))
            }
            inputProps={{ maxLength: 20 }}
          />
          <TextField
            label="显示名称（可选，留空同 ID）"
            fullWidth
            size="small"
            sx={{ mt: 1.5 }}
            value={newUsername}
            onChange={(e) => setNewUsername(e.target.value)}
            inputProps={{ maxLength: 30 }}
          />
          <TextField
            label="PIN（6 位数字）"
            fullWidth
            size="small"
            sx={{ mt: 1.5 }}
            type="password"
            value={newPin}
            onChange={(e) =>
              setNewPin(e.target.value.replace(/\D/g, "").slice(0, 6))
            }
          />
          <FeatureGatesPanel
            value={featureGateChangesFromMask(newFeatureMask)}
            allowUnchanged={false}
            onChange={(gate, change) =>
              setNewFeatureMask((mask) =>
                setFeature(mask, gate, change === "enabled"),
              )
            }
          />
          {createErr && (
            <Alert severity="error" sx={{ mt: 1 }}>
              {createErr}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)}>取消</Button>
          <Button
            variant="contained"
            onClick={handleCreate}
            disabled={creating}
          >
            创建
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
