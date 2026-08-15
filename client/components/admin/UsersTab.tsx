import { useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
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
import DeleteForeverIcon from "@mui/icons-material/DeleteForever";
import PersonOffIcon from "@mui/icons-material/PersonOff";
import EditIcon from "@mui/icons-material/Edit";
import AddIcon from "@mui/icons-material/Add";
import { flexGap } from "@/client/lib/css";
import type { User } from "@/shared/types/api";
import {
  ADMIN_ROLES,
  ADMIN_ROLE_DESCRIPTIONS,
  ADMIN_ROLE_LABELS,
  roleDependencies,
  type AdminRole,
} from "@/shared/authority";
import {
  adminFetchUsers,
  adminCreateUser,
  adminUpdateUser,
  adminDeleteUser,
  adminFetchAiCredits,
  adminTopUpAiCredits,
  adminAssignAiPlan,
  adminBatchUpdateUserFeatures,
} from "@/client/api/admin";
import type { AiCreditBalance } from "@/shared/types/api";
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
  DEFAULT_USER_FEATURES,
  FEATURES,
  type UserFeatures,
} from "@/shared/features";
import {
  FeatureGatesPanel,
  aggregateFeatureGateStates,
  applyFeatureGateChanges,
  createUnchangedFeatureGateChanges,
  featureGateChangesFromFeatures,
  type FeatureGateChange,
} from "./FeatureGatesPanel";
import { MultiSectionDurationPicker } from "./MultiSectionDurationPicker";
import { AdminDataGrid, type AdminGridColumn } from "./AdminDataGrid";

export function UsersTab({ currentUser }: { currentUser: User }) {
  const hasRole = (role: AdminRole) =>
    currentUser.administration.roles.includes(role);
  const canRoot = hasRole("root");
  const canManageFeatures = hasRole("feature_manager");
  const canCreateUsers = hasRole("access_manager");
  const canModerate = hasRole("community_manager");
  const canManageProfiles = hasRole("advanced_community_manager");
  const canEdit =
    canRoot || canManageFeatures || canModerate || canManageProfiles;
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  const { data, loading, reload } = useActionQuery<{
    users: User[];
    total: number;
  }>(() => adminFetchUsers(q, offset), [q, offset]);

  const [editUser, setEditUser] = useState<User | null>(null);
  const [editHandle, setEditHandle] = useState("");
  const [editUsername, setEditUsername] = useState("");
  const [editFeatures, setEditFeatures] = useState<UserFeatures>({
    ...DEFAULT_USER_FEATURES,
  });
  const [editRoles, setEditRoles] = useState<AdminRole[]>([]);
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
  const [editAiCredits, setEditAiCredits] = useState<AiCreditBalance | null>(
    null,
  );
  const [topUpAmount, setTopUpAmount] = useState("");
  const [topUpNote, setTopUpNote] = useState("");
  const [topUpSaving, setTopUpSaving] = useState(false);
  const [planDays, setPlanDays] = useState("30");
  const editLoadRef = useRef(0);

  const [createOpen, setCreateOpen] = useState(false);
  const [newHandle, setNewHandle] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [newPin, setNewPin] = useState("");
  const [newFeatures, setNewFeatures] = useState<UserFeatures>({
    ...DEFAULT_USER_FEATURES,
  });
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
    const generation = ++editLoadRef.current;
    setEditUser(u);
    setEditHandle(u.handle);
    setEditUsername(u.username);
    setEditFeatures({ ...u.features });
    setEditRoles([...u.administration.roles]);
    setEditPin("");
    setEditMuted(!!u.is_muted);
    setEditMuteDays(1);
    setEditMuteHours(0);
    setEditBanned(isFuture(u.banned_until));
    setEditBanDays(1);
    setEditBanHours(0);
    setEditErr("");
    setEditAiCredits(null);
    setTopUpAmount("");
    setTopUpNote("");

    if (!canManageFeatures) return;
    try {
      const [discipline, credits] = await Promise.all([
        adminFetchSelfDisciplineMode(u.id),
        adminFetchAiCredits(u.id),
      ]);
      if (editLoadRef.current !== generation) return;
      setEditSelfDiscipline(discipline.enabled || false);
      setEditAiCredits(credits.credits);
    } catch (error) {
      if (editLoadRef.current === generation) {
        setEditErr(error instanceof Error ? error.message : "加载用户信息失败");
      }
    }
  };

  const createIdempotencyKey = (): string => {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
  };

  const handleTopUp = async () => {
    if (!editUser) return;
    const amount = Number(topUpAmount);
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      setEditErr("充值数量必须是正整数");
      return;
    }
    setTopUpSaving(true);
    setEditErr("");
    try {
      const credits = await adminTopUpAiCredits({
        userId: editUser.id,
        amount,
        idempotencyKey: createIdempotencyKey(),
        note: topUpNote.trim() || "Admin top-up",
      });
      setEditAiCredits(credits);
      setTopUpAmount("");
      setTopUpNote("");
    } catch (error) {
      setEditErr(error instanceof Error ? error.message : "充值失败");
    } finally {
      setTopUpSaving(false);
    }
  };

  const handleAssignPlan = async () => {
    if (!editUser) return;
    const durationDays = Number(planDays);
    if (!Number.isSafeInteger(durationDays) || durationDays <= 0) {
      setEditErr("套餐天数必须是正整数");
      return;
    }
    setTopUpSaving(true);
    setEditErr("");
    try {
      setEditAiCredits(
        await adminAssignAiPlan({ userId: editUser.id, durationDays }),
      );
    } catch (error) {
      setEditErr(error instanceof Error ? error.message : "套餐分配失败");
    } finally {
      setTopUpSaving(false);
    }
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
    const body: Record<string, unknown> = {};
    if (canManageProfiles) {
      body.handle = editHandle;
      body.username = editUsername;
    }
    if (canManageFeatures) body.features = editFeatures;
    if (canRoot) body.roles = editRoles;
    if (canModerate) {
      if (wasMuted && !editMuted) body.unmute = true;
      if (!wasMuted && editMuted) body.mute_hours = muteHours;
      if (wasBanned && !editBanned) body.unban = true;
      if (!wasBanned && editBanned) body.ban_hours = banHours;
      if (editPin) body.pin = editPin;
    }
    if (Object.keys(body).length > 0) {
      const { res, data } = await adminUpdateUser(editUser.id, body);
      if (!res.ok) {
        setEditSaving(false);
        setEditErr(("error" in data && data.error) || "失败");
        return;
      }
    }

    if (canManageFeatures) {
      await adminUpdateSelfDisciplineMode(editUser.id, editSelfDiscipline);
    }

    setEditSaving(false);
    setEditUser(null);
    reload();
  };

  const handleDelete = async (id: string, mode: "purge" | "deactivate") => {
    const message =
      mode === "purge"
        ? "确认彻底清除该干员及其所有业务数据？此操作不可恢复。"
        : "确认注销该干员？账号将无法登录并退出所有群组，其他历史数据保留。";
    if (!confirm(message)) return;
    await adminDeleteUser(id, mode);
    reload();
  };

  const handleCreate = async () => {
    setCreating(true);
    setCreateErr("");
    const { res, data } = await adminCreateUser({
      handle: newHandle,
      username: newUsername || newHandle,
      pin: newPin,
      ...(canManageFeatures ? { features: newFeatures } : {}),
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
    setNewFeatures({ ...DEFAULT_USER_FEATURES });
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
          features: applyFeatureGateChanges(user.features, batchGateChanges),
        }))
        .filter(({ user, features }) =>
          FEATURES.some(
            (feature) => features[feature] !== user.features[feature],
          ),
        );
      await adminBatchUpdateUserFeatures(
        updates.map(({ user, features }) => ({ userId: user.id, features })),
      );
      setBatchGateChanges(createUnchangedFeatureGateChanges());
      setBatchAnchorEl(null);
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
  const columns: AdminGridColumn<User>[] = [
    {
      id: "identity",
      label: (
        <Box sx={{ display: "flex", alignItems: "center" }}>
          {canManageFeatures ? (
            <Checkbox
              size="small"
              checked={
                (data?.users.length ?? 0) > 0 &&
                (data?.users ?? []).every((user) => selectedIds.has(user.id))
              }
              indeterminate={
                (data?.users ?? []).some((user) => selectedIds.has(user.id)) &&
                !(data?.users ?? []).every((user) => selectedIds.has(user.id))
              }
              onClick={(event) => event.stopPropagation()}
              onChange={(event) =>
                setSelectedIds(
                  event.target.checked
                    ? new Set((data?.users ?? []).map((user) => user.id))
                    : new Set(),
                )
              }
            />
          ) : null}
          账号
        </Box>
      ),
      width: 250,
      render: (user) => (
        <Box sx={{ display: "flex", alignItems: "center", minWidth: 0 }}>
          {canManageFeatures ? (
            <Checkbox
              size="small"
              checked={selectedIds.has(user.id)}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) =>
                setSelectedIds((current) => {
                  const next = new Set(current);
                  if (event.target.checked) next.add(user.id);
                  else next.delete(user.id);
                  return next;
                })
              }
            />
          ) : null}
          <Typography
            variant="body2"
            sx={{ fontFamily: "monospace", overflow: "hidden" }}
          >
            @{user.handle}
          </Typography>
        </Box>
      ),
    },
    {
      id: "name",
      label: "显示名称",
      width: 180,
      render: (user) => user.username,
      longText: (user) => user.username,
    },
    {
      id: "roles",
      label: "管理职责",
      width: 320,
      render: (user) =>
        user.administration.roles.length
          ? user.administration.roles
              .map((role) => ADMIN_ROLE_LABELS[role])
              .join("、")
          : "—",
      longText: (user) =>
        user.administration.roles
          .map(
            (role) =>
              `${ADMIN_ROLE_LABELS[role]}：${ADMIN_ROLE_DESCRIPTIONS[role]}`,
          )
          .join("\n"),
    },
    {
      id: "status",
      label: "状态",
      width: 240,
      render: (user) => (
        <Box sx={{ display: "flex", gap: 0.5 }}>
          {user.is_muted ? (
            <Chip label="禁言" size="small" color="warning" />
          ) : null}
          {isBanned(user) ? (
            <Chip label="已封禁" size="small" color="error" />
          ) : null}
          {!user.is_muted && !isBanned(user) ? "正常" : null}
        </Box>
      ),
    },
    {
      id: "created",
      label: "注册时间",
      width: 180,
      render: (user) => user.created_at.slice(0, 16),
    },
    {
      id: "actions",
      label: "操作",
      width: 150,
      render: (user) => (
        <Box sx={{ display: "flex" }}>
          {canEdit ? (
            <IconButton
              size="small"
              title="编辑"
              onClick={(event) => {
                event.stopPropagation();
                void openEdit(user);
              }}
            >
              <EditIcon fontSize="small" />
            </IconButton>
          ) : null}
          {canManageProfiles ? (
            <IconButton
              size="small"
              title="注销账号并保留历史数据"
              onClick={(event) => {
                event.stopPropagation();
                void handleDelete(user.id, "deactivate");
              }}
            >
              <PersonOffIcon fontSize="small" />
            </IconButton>
          ) : null}
          {canManageProfiles ? (
            <IconButton
              size="small"
              color="error"
              title="彻底清除账号和业务数据"
              onClick={(event) => {
                event.stopPropagation();
                void handleDelete(user.id, "purge");
              }}
            >
              <DeleteForeverIcon fontSize="small" />
            </IconButton>
          ) : null}
        </Box>
      ),
    },
  ];

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
            setSelectedIds(new Set());
          }}
          sx={{ flex: 1, mr: 1 }}
        />
        {canCreateUsers ? (
          <Button
            startIcon={<AddIcon />}
            variant="contained"
            size="small"
            onClick={() => setCreateOpen(true)}
          >
            新建干员
          </Button>
        ) : null}
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
        <AdminDataGrid
          rows={data?.users ?? []}
          columns={columns}
          rowKey={(user) => user.id}
          empty="没有符合条件的人员"
        />
      )}

      {data && data.total > 50 && (
        <Box sx={{ mt: 1, display: "flex", alignItems: "center" }}>
          <Button
            size="small"
            disabled={offset === 0}
            onClick={() => {
              setSelectedIds(new Set());
              setOffset((o) => Math.max(0, o - 50));
            }}
          >
            上一页
          </Button>
          <Typography variant="caption" sx={{ mx: 1 }}>
            {offset + 1}–{Math.min(offset + 50, data.total)} / {data.total}
          </Typography>
          <Button
            size="small"
            disabled={offset + 50 >= data.total}
            onClick={() => {
              setSelectedIds(new Set());
              setOffset((o) => o + 50);
            }}
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
          {canManageProfiles ? (
            <>
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
            </>
          ) : null}
          {canManageFeatures ? (
            <FeatureGatesPanel
              value={featureGateChangesFromFeatures(editFeatures)}
              allowUnchanged={false}
              onChange={(gate, change) =>
                setEditFeatures((features) => ({
                  ...features,
                  [gate]: change === "enabled",
                }))
              }
            />
          ) : null}
          {canRoot ? (
            <Paper variant="outlined" sx={{ mt: 1.5, p: 1.5 }}>
              <Typography variant="subtitle2" fontWeight={700}>
                管理角色
              </Typography>
              <Typography variant="caption" color="text.secondary">
                角色只表达管理职责；普通产品功能在上方单独配置。
              </Typography>
              <Box sx={{ display: "grid", mt: 1 }}>
                {ADMIN_ROLES.map((role) => (
                  <FormControlLabel
                    key={role}
                    control={
                      <Checkbox
                        size="small"
                        checked={editRoles.includes(role)}
                        onChange={(_, enabled) =>
                          setEditRoles((current) => {
                            if (!enabled) {
                              if (role === "administrator") return [];
                              const removed = new Set<AdminRole>([role]);
                              for (const candidate of ADMIN_ROLES) {
                                if (
                                  roleDependencies(candidate).some(
                                    (dependency) => removed.has(dependency),
                                  )
                                ) {
                                  removed.add(candidate);
                                }
                              }
                              return current.filter(
                                (item) => !removed.has(item),
                              );
                            }
                            return [
                              ...new Set<AdminRole>([
                                ...current,
                                ...roleDependencies(role),
                                role,
                              ]),
                            ];
                          })
                        }
                      />
                    }
                    label={
                      <Box>
                        <Typography variant="body2">
                          {ADMIN_ROLE_LABELS[role]}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {ADMIN_ROLE_DESCRIPTIONS[role]}
                        </Typography>
                      </Box>
                    }
                  />
                ))}
              </Box>
            </Paper>
          ) : null}
          {canModerate ? (
            <>
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
            </>
          ) : null}
          {canManageFeatures ? (
            <>
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

              <Paper variant="outlined" sx={{ mt: 1.5, p: 1.5 }}>
                <Typography variant="subtitle2" fontWeight={700}>
                  AI Credits
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  日额度已用 {editAiCredits?.plan.daily.used_percent ?? "…"}% ·
                  周额度已用 {editAiCredits?.plan.weekly.used_percent ?? "…"}% ·
                  额外 {editAiCredits?.top_up ?? "…"} credits
                </Typography>
                <Box sx={{ display: "flex", ...flexGap(1), mt: 1 }}>
                  <TextField
                    label="套餐天数"
                    size="small"
                    inputMode="numeric"
                    value={planDays}
                    onChange={(event) =>
                      setPlanDays(event.target.value.replace(/\D/g, ""))
                    }
                    sx={{ width: 120 }}
                  />
                  <Button
                    disabled={topUpSaving || !planDays}
                    onClick={() => void handleAssignPlan()}
                  >
                    分配套餐
                  </Button>
                </Box>
                <Box sx={{ display: "flex", ...flexGap(1), mt: 1 }}>
                  <TextField
                    label="充值数量"
                    size="small"
                    inputMode="numeric"
                    value={topUpAmount}
                    onChange={(event) =>
                      setTopUpAmount(event.target.value.replace(/\D/g, ""))
                    }
                    sx={{ width: 130 }}
                  />
                  <TextField
                    label="备注"
                    size="small"
                    value={topUpNote}
                    onChange={(event) =>
                      setTopUpNote(event.target.value.slice(0, 200))
                    }
                    sx={{ flex: 1 }}
                  />
                  <Button
                    disabled={topUpSaving || !topUpAmount}
                    onClick={() => void handleTopUp()}
                  >
                    充值
                  </Button>
                </Box>
              </Paper>
            </>
          ) : null}

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
          {canManageFeatures ? (
            <FeatureGatesPanel
              value={featureGateChangesFromFeatures(newFeatures)}
              allowUnchanged={false}
              onChange={(gate, change) =>
                setNewFeatures((features) => ({
                  ...features,
                  [gate]: change === "enabled",
                }))
              }
            />
          ) : null}
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
