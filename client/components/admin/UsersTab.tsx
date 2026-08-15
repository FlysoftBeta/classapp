import { useRef, useState } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import Switch from "@mui/material/Switch";
import FormControlLabel from "@mui/material/FormControlLabel";
import Alert from "@mui/material/Alert";
import CircularProgress from "@mui/material/CircularProgress";
import Chip from "@mui/material/Chip";
import DeleteForeverIcon from "@mui/icons-material/DeleteForever";
import PersonOffIcon from "@mui/icons-material/PersonOff";
import EditIcon from "@mui/icons-material/Edit";
import AddIcon from "@mui/icons-material/Add";
import TuneIcon from "@mui/icons-material/Tune";
import PaymentsIcon from "@mui/icons-material/Payments";
import BlockIcon from "@mui/icons-material/Block";
import type { User } from "@/shared/types/api";
import {
  ADMIN_ROLE_DESCRIPTIONS,
  ADMIN_ROLE_LABELS,
  type AdminRole,
} from "@/shared/authority";
import {
  adminFetchUsers,
  adminCreateUser,
  adminFetchAiCredits,
  adminMutateUsers,
  adminAssignAiCredits,
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
import { formatDeviceDateTime } from "@/client/lib/deviceTime";
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
import { AdminDataGrid, type AdminGridColumn } from "./AdminDataGrid";
import {
  BATCH_INCREMENTAL_HELP,
  type IncrementalBoolean,
} from "./IncrementalField";
import { HelpSection } from "@/client/components/shared/HelpTip";
import { AiCreditsFields, RestrictionFields } from "./UserOperationFields";
import { SelectionActionBar, SelectionActionIcon } from "./SelectionActionBar";
import {
  RoleManagementFields,
  aggregateRoleStates,
  applyRoleChanges,
  createUnchangedRoleChanges,
} from "./RoleManagementFields";

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
  const [editSection, setEditSection] = useState<
    "profile" | "access" | "credits" | "restrict"
  >("profile");
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
  const [planDays, setPlanDays] = useState("");
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
  const [batchGateChanges, setBatchGateChanges] = useState(
    createUnchangedFeatureGateChanges,
  );
  const [batchRoleChanges, setBatchRoleChanges] = useState(
    createUnchangedRoleChanges,
  );
  const [batchCommand, setBatchCommand] = useState<
    "access" | "credits" | "restrict" | null
  >(null);
  const [batchCreditAmount, setBatchCreditAmount] = useState("");
  const [batchPlanDays, setBatchPlanDays] = useState("");
  const [batchCreditNote, setBatchCreditNote] = useState("");
  const [batchMute, setBatchMute] = useState<IncrementalBoolean>("unchanged");
  const [batchBan, setBatchBan] = useState<IncrementalBoolean>("unchanged");
  const [batchRestrictDays, setBatchRestrictDays] = useState(1);
  const [batchRestrictHours, setBatchRestrictHours] = useState(0);

  const openEdit = async (u: User, section: typeof editSection = "profile") => {
    const generation = ++editLoadRef.current;
    setEditSection(section);
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
    setPlanDays("");

    if (!canManageFeatures || (section !== "access" && section !== "credits"))
      return;
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

  const handleApplySingleCredits = async () => {
    if (!editUser) return;
    const amount = Number(topUpAmount);
    const durationDays = Number(planDays);
    const hasAmount = Number.isSafeInteger(amount) && amount > 0;
    const hasDuration = Number.isSafeInteger(durationDays) && durationDays > 0;
    if (!hasAmount && !hasDuration) {
      setEditErr("请填写套餐天数或充值数量");
      return;
    }
    setTopUpSaving(true);
    setEditErr("");
    try {
      await adminAssignAiCredits({
        userIds: [editUser.id],
        ...(hasDuration ? { durationDays } : {}),
        ...(hasAmount ? { amount } : {}),
        note: topUpNote.trim() || "Admin credit assignment",
      });
      setEditAiCredits((await adminFetchAiCredits(editUser.id)).credits);
      setTopUpAmount("");
      setTopUpNote("");
      setPlanDays("");
    } catch (error) {
      setEditErr(error instanceof Error ? error.message : "配额分配失败");
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
    if (canManageProfiles && editSection === "profile") {
      body.handle = editHandle;
      body.username = editUsername;
      if (canModerate && editPin) body.pin = editPin;
    }
    if (canManageFeatures && editSection === "access")
      body.features = editFeatures;
    if (canRoot && editSection === "access") body.roles = editRoles;
    if (canModerate && editSection === "restrict") {
      if (wasMuted && !editMuted) body.unmute = true;
      if (!wasMuted && editMuted) body.mute_hours = muteHours;
      if (wasBanned && !editBanned) body.unban = true;
      if (!wasBanned && editBanned) body.ban_hours = banHours;
    }
    if (Object.keys(body).length > 0) {
      try {
        await adminMutateUsers([{ userId: editUser.id, ...body }]);
      } catch (error) {
        setEditSaving(false);
        setEditErr(error instanceof Error ? error.message : "失败");
        return;
      }
    }

    if (canManageFeatures && editSection === "access") {
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
    await adminMutateUsers([{ userId: id, removal: mode }]);
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
  const hasBatchRoleChanges = Object.values(batchRoleChanges).some(
    (change) => change !== "unchanged",
  );
  const hasBatchAccessChanges = hasBatchGateChanges || hasBatchRoleChanges;
  const batchGateAggregateStates = aggregateFeatureGateStates(selectedUsers);
  const batchRoleAggregateStates = aggregateRoleStates(selectedUsers);
  const handleBatchGateChange = (
    gate: keyof typeof batchGateChanges,
    change: FeatureGateChange,
  ) => {
    setBatchErr("");
    setBatchGateChanges((current) => ({ ...current, [gate]: change }));
  };
  const handleApplyBatchGates = async () => {
    if (selectedUsers.length === 0 || !hasBatchAccessChanges) return;
    setBatchSaving(true);
    setBatchErr("");
    try {
      const updates = selectedUsers.flatMap((user) => {
        const features = applyFeatureGateChanges(
          user.features,
          batchGateChanges,
        );
        const roles = applyRoleChanges(
          user.administration.roles,
          batchRoleChanges,
        );
        const featuresChanged = FEATURES.some(
          (feature) => features[feature] !== user.features[feature],
        );
        const rolesChanged =
          roles.length !== user.administration.roles.length ||
          roles.some((role) => !user.administration.roles.includes(role));
        if (!featuresChanged && !rolesChanged) return [];
        return [
          {
            userId: user.id,
            ...(featuresChanged ? { features } : {}),
            ...(rolesChanged ? { roles } : {}),
          },
        ];
      });
      if (updates.length > 0) await adminMutateUsers(updates);
      setBatchGateChanges(createUnchangedFeatureGateChanges());
      setBatchRoleChanges(createUnchangedRoleChanges());
      setBatchCommand(null);
      setSelectedIds(new Set());
      reload();
    } catch (error) {
      setBatchErr(error instanceof Error ? error.message : "应用失败");
    } finally {
      setBatchSaving(false);
    }
  };
  const handleOpenBatchAccess = () => {
    setBatchErr("");
    setBatchGateChanges(createUnchangedFeatureGateChanges());
    setBatchRoleChanges(createUnchangedRoleChanges());
    setBatchCommand("access");
  };
  const applyBatchCredits = async () => {
    const amount = Number(batchCreditAmount);
    const durationDays = Number(batchPlanDays);
    if ((!amount || amount < 0) && (!durationDays || durationDays < 0)) return;
    setBatchSaving(true);
    setBatchErr("");
    try {
      await adminAssignAiCredits({
        userIds: selectedUsers.map((user) => user.id),
        ...(Number.isSafeInteger(durationDays) && durationDays > 0
          ? { durationDays }
          : {}),
        ...(Number.isSafeInteger(amount) && amount > 0 ? { amount } : {}),
        note: batchCreditNote.trim() || "Admin batch top-up",
      });
      setBatchCommand(null);
      setSelectedIds(new Set());
      setBatchCreditAmount("");
      reload();
    } catch (error) {
      setBatchErr(error instanceof Error ? error.message : "批量分配失败");
    } finally {
      setBatchSaving(false);
    }
  };
  const aggregateUserState = (
    field: "mute" | "ban",
  ): "enabled" | "disabled" | "mixed" => {
    const values = selectedUsers.map((user) =>
      field === "mute" ? !!user.is_muted : isBanned(user),
    );
    return values.every(Boolean)
      ? "enabled"
      : values.every((value) => !value)
        ? "disabled"
        : "mixed";
  };
  const applyBatchRestrictions = async () => {
    const duration = batchRestrictDays * 24 + batchRestrictHours;
    if ((batchMute === "enabled" || batchBan === "enabled") && duration <= 0) {
      setBatchErr("限制时长不能为 0");
      return;
    }
    setBatchSaving(true);
    setBatchErr("");
    try {
      const updates = selectedUsers
        .map((user) => {
          const body: Record<string, unknown> = {};
          if (batchMute === "enabled" && !user.is_muted)
            body.mute_hours = duration;
          if (batchMute === "disabled" && user.is_muted) body.unmute = true;
          if (batchBan === "enabled" && !isBanned(user))
            body.ban_hours = duration;
          if (batchBan === "disabled" && isBanned(user)) body.unban = true;
          return { userId: user.id, ...body };
        })
        .filter((update) => Object.keys(update).length > 1);
      if (updates.length) await adminMutateUsers(updates);
      setBatchCommand(null);
      setBatchMute("unchanged");
      setBatchBan("unchanged");
      setSelectedIds(new Set());
      reload();
    } catch (error) {
      setBatchErr(error instanceof Error ? error.message : "批量限制失败");
    } finally {
      setBatchSaving(false);
    }
  };
  const applyBatchRemoval = async (mode: "purge" | "deactivate") => {
    const label =
      mode === "purge" ? "彻底删除及其关联数据" : "注销并保留历史数据";
    if (!confirm(`确认对选中的 ${selectedUsers.length} 个账号执行“${label}”？`))
      return;
    setBatchSaving(true);
    try {
      await adminMutateUsers(
        selectedUsers.map((user) => ({ userId: user.id, removal: mode })),
      );
      setSelectedIds(new Set());
      reload();
    } finally {
      setBatchSaving(false);
    }
  };
  const columns: AdminGridColumn<User>[] = [
    {
      id: "identity",
      label: "账号",
      width: 210,
      pinned: "start",
      hideable: false,
      render: (user) => (
        <Box sx={{ display: "flex", alignItems: "center", minWidth: 0 }}>
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
      render: (user) => formatDeviceDateTime(user.created_at),
    },
    {
      id: "actions",
      label: "操作",
      width: 220,
      pinned: "end",
      hideable: false,
      render: (user) => (
        <Box sx={{ display: "flex" }}>
          {canManageProfiles ? (
            <IconButton
              size="small"
              title="编辑"
              onClick={(event) => {
                event.stopPropagation();
                void openEdit(user, "profile");
              }}
            >
              <EditIcon fontSize="small" />
            </IconButton>
          ) : null}
          {canManageFeatures || canRoot ? (
            <IconButton
              size="small"
              title={canRoot ? "配置可用功能与管理角色" : "配置可用功能"}
              onClick={(event) => {
                event.stopPropagation();
                void openEdit(user, "access");
              }}
            >
              <TuneIcon fontSize="small" />
            </IconButton>
          ) : null}
          {canManageFeatures ? (
            <IconButton
              size="small"
              title="分配 AI 配额"
              onClick={(event) => {
                event.stopPropagation();
                void openEdit(user, "credits");
              }}
            >
              <PaymentsIcon fontSize="small" />
            </IconButton>
          ) : null}
          {canModerate ? (
            <IconButton
              size="small"
              title="限制"
              onClick={(event) => {
                event.stopPropagation();
                void openEdit(user, "restrict");
              }}
            >
              <BlockIcon fontSize="small" />
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
      <HelpSection label="人员、权限与限制的生效方式">
        <Typography variant="body2" color="text.secondary">
          个人资料描述“这个人是谁”；可用功能决定其产品能力；管理角色授予后台职责。AI
          套餐与充值、禁言与封禁、注销和彻底删除是命令操作，从右侧操作栏发起；登录凭据属于账号资料，在“编辑个人信息”中重置。注销会撤销登录能力并退出群组但保留历史内容；彻底删除还会清除关联业务数据，无法恢复。
        </Typography>
      </HelpSection>
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

      {loading ? (
        <CircularProgress size={24} />
      ) : (
        <AdminDataGrid
          rows={data?.users ?? []}
          columns={columns}
          rowKey={(user) => user.id}
          empty="没有符合条件的人员"
          selection={
            canEdit
              ? {
                  selectedKeys: selectedIds,
                  onChange: (keys) =>
                    setSelectedIds(new Set([...keys].map(String))),
                }
              : undefined
          }
          bulkActionBar={
            selectedUsers.length ? (
              <SelectionActionBar
                label={`已选 ${selectedUsers.length} 人`}
                onClear={() => setSelectedIds(new Set())}
              >
                {canManageFeatures || canRoot ? (
                  <SelectionActionIcon
                    label={canRoot ? "配置可用功能与管理角色" : "配置可用功能"}
                    color="primary"
                    disabled={batchSaving}
                    onClick={handleOpenBatchAccess}
                  >
                    <TuneIcon fontSize="small" />
                  </SelectionActionIcon>
                ) : null}
                {canManageFeatures ? (
                  <SelectionActionIcon
                    label="分配 AI 配额"
                    onClick={() => {
                      setBatchErr("");
                      setBatchCommand("credits");
                    }}
                  >
                    <PaymentsIcon fontSize="small" />
                  </SelectionActionIcon>
                ) : null}
                {canModerate ? (
                  <SelectionActionIcon
                    label="限制"
                    onClick={() => {
                      setBatchErr("");
                      setBatchCommand("restrict");
                    }}
                  >
                    <BlockIcon fontSize="small" />
                  </SelectionActionIcon>
                ) : null}
                {canManageProfiles ? (
                  <SelectionActionIcon
                    label="注销账号并保留历史数据"
                    onClick={() => void applyBatchRemoval("deactivate")}
                  >
                    <PersonOffIcon fontSize="small" />
                  </SelectionActionIcon>
                ) : null}
                {canManageProfiles ? (
                  <SelectionActionIcon
                    label="彻底删除账号及关联数据"
                    color="error"
                    onClick={() => void applyBatchRemoval("purge")}
                  >
                    <DeleteForeverIcon fontSize="small" />
                  </SelectionActionIcon>
                ) : null}
              </SelectionActionBar>
            ) : null
          }
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

      <Dialog
        open={batchCommand === "access"}
        onClose={() => !batchSaving && setBatchCommand(null)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitleWithHelp help={BATCH_INCREMENTAL_HELP}>
          {canRoot ? "配置可用功能与管理角色" : "配置可用功能"} ·{" "}
          {selectedUsers.length} 人
        </DialogTitleWithHelp>
        <DialogContent>
          {canManageFeatures ? (
            <Box sx={{ mt: 0.5 }}>
              <Typography variant="subtitle2" fontWeight={700}>
                可用功能
              </Typography>
              <FeatureGatesPanel
                value={batchGateChanges}
                aggregateValue={batchGateAggregateStates}
                onChange={handleBatchGateChange}
              />
            </Box>
          ) : null}
          {canRoot ? (
            <Box sx={{ mt: canManageFeatures ? 2 : 0.5 }}>
              <Typography variant="subtitle2" fontWeight={700}>
                管理角色
              </Typography>
              <Typography variant="caption" color="text.secondary">
                启用角色会一并授予前置角色；撤销前置角色会同时撤销依赖它的角色。
              </Typography>
              <RoleManagementFields
                mode="batch"
                changes={batchRoleChanges}
                aggregate={batchRoleAggregateStates}
                onChange={setBatchRoleChanges}
              />
            </Box>
          ) : null}
          {batchErr ? (
            <Alert severity="error" sx={{ mt: 1 }}>
              {batchErr}
            </Alert>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button disabled={batchSaving} onClick={() => setBatchCommand(null)}>
            取消
          </Button>
          <Button
            variant="contained"
            disabled={batchSaving || !hasBatchAccessChanges}
            onClick={() => void handleApplyBatchGates()}
          >
            应用
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={batchCommand === "credits"}
        onClose={() => !batchSaving && setBatchCommand(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitleWithHelp help="批量操作不展示余额，因为所选人员可能具有不同的计划窗口与充值余额。填写的数量会作为相同增量分别应用到每个人。">
          批量分配 AI 配额
        </DialogTitleWithHelp>
        <DialogContent>
          <AiCreditsFields
            targetDescription={`将填写的额度增量分别应用到 ${selectedUsers.length} 个账号；批量模式不显示各账号余额。`}
            planDays={batchPlanDays}
            amount={batchCreditAmount}
            note={batchCreditNote}
            onPlanDaysChange={setBatchPlanDays}
            onAmountChange={setBatchCreditAmount}
            onNoteChange={setBatchCreditNote}
          />
          {batchErr ? (
            <Alert severity="error" sx={{ mt: 1 }}>
              {batchErr}
            </Alert>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button disabled={batchSaving} onClick={() => setBatchCommand(null)}>
            取消
          </Button>
          <Button
            variant="contained"
            disabled={batchSaving || (!batchPlanDays && !batchCreditAmount)}
            onClick={() => void applyBatchCredits()}
          >
            应用到 {selectedUsers.length} 人
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={batchCommand === "restrict"}
        onClose={() => !batchSaving && setBatchCommand(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitleWithHelp help={BATCH_INCREMENTAL_HELP}>
          批量限制
        </DialogTitleWithHelp>
        <DialogContent>
          <RestrictionFields
            mode="batch"
            mute={batchMute}
            ban={batchBan}
            muteAggregate={aggregateUserState("mute")}
            banAggregate={aggregateUserState("ban")}
            onMuteChange={setBatchMute}
            onBanChange={setBatchBan}
            duration={
              batchMute === "enabled" || batchBan === "enabled"
                ? {
                    days: batchRestrictDays,
                    hours: batchRestrictHours,
                    onDaysChange: setBatchRestrictDays,
                    onHoursChange: setBatchRestrictHours,
                  }
                : undefined
            }
          />
          {batchErr ? (
            <Alert severity="error" sx={{ mt: 1 }}>
              {batchErr}
            </Alert>
          ) : null}
        </DialogContent>
        <DialogActions>
          <Button disabled={batchSaving} onClick={() => setBatchCommand(null)}>
            取消
          </Button>
          <Button
            variant="contained"
            disabled={
              batchSaving ||
              (batchMute === "unchanged" && batchBan === "unchanged")
            }
            onClick={() => void applyBatchRestrictions()}
          >
            应用到 {selectedUsers.length} 人
          </Button>
        </DialogActions>
      </Dialog>

      {/* Edit dialog */}
      <Dialog
        open={!!editUser}
        onClose={() => setEditUser(null)}
        maxWidth={editSection === "access" ? "sm" : "xs"}
        fullWidth
      >
        <DialogTitleWithHelp
          help={
            editSection === "profile"
              ? "修改公开身份信息；填写新 PIN 时，旧 PIN 会在保存后立即失效。"
              : editSection === "access"
                ? "配置产品功能与管理职责；保存后立即用于后续权限检查。"
                : editSection === "credits"
                  ? "套餐按时间窗口提供额度，充值 credits 作为额外余额；两个命令分别立即生效。"
                  : "禁言限制发布能力；封禁会同时撤销现有会话。"
          }
        >
          {
            {
              profile: "编辑个人信息",
              access: canRoot ? "配置可用功能与管理角色" : "配置可用功能",
              credits: "分配 AI 配额",
              restrict: "限制账号",
            }[editSection]
          }
        </DialogTitleWithHelp>
        <DialogContent>
          {canManageProfiles && editSection === "profile" ? (
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
              {canModerate ? (
                <TextField
                  label={
                    <LabelWithHelp
                      label="重置 PIN（留空不变）"
                      help="填写并保存后，所有旧 PIN 立即失效。"
                    />
                  }
                  fullWidth
                  size="small"
                  sx={{ mt: 1.5 }}
                  type="password"
                  value={editPin}
                  onChange={(event) =>
                    setEditPin(
                      event.target.value.replace(/\D/g, "").slice(0, 6),
                    )
                  }
                />
              ) : null}
            </>
          ) : null}
          {canManageFeatures && editSection === "access" ? (
            <Box sx={{ mt: 0.5 }}>
              <Typography variant="subtitle2" fontWeight={700}>
                可用功能
              </Typography>
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
            </Box>
          ) : null}
          {canRoot && editSection === "access" ? (
            <Box sx={{ mt: canManageFeatures ? 2 : 0.5 }}>
              <Typography variant="subtitle2" fontWeight={700}>
                管理角色
              </Typography>
              <Typography variant="caption" color="text.secondary">
                角色只表达管理职责；普通产品功能在上方单独配置。
              </Typography>
              <RoleManagementFields
                mode="single"
                roles={editRoles}
                onChange={setEditRoles}
              />
            </Box>
          ) : null}
          {canModerate && editSection === "restrict" && editUser ? (
            <RestrictionFields
              mode="single"
              muted={editMuted}
              banned={editBanned}
              onMutedChange={setEditMuted}
              onBannedChange={setEditBanned}
              muteDuration={
                editMuted && !editUser.is_muted
                  ? {
                      days: editMuteDays,
                      hours: editMuteHours,
                      onDaysChange: setEditMuteDays,
                      onHoursChange: setEditMuteHours,
                    }
                  : undefined
              }
              banDuration={
                editBanned && !isBanned(editUser)
                  ? {
                      days: editBanDays,
                      hours: editBanHours,
                      onDaysChange: setEditBanDays,
                      onHoursChange: setEditBanHours,
                    }
                  : undefined
              }
            />
          ) : null}
          {canManageFeatures && editSection === "access" ? (
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
            </>
          ) : null}
          {canManageFeatures && editSection === "credits" ? (
            <AiCreditsFields
              balance={editAiCredits}
              targetDescription="填写套餐期限和/或额外 credits；留空字段不会改变。"
              planDays={planDays}
              amount={topUpAmount}
              note={topUpNote}
              onPlanDaysChange={setPlanDays}
              onAmountChange={setTopUpAmount}
              onNoteChange={setTopUpNote}
            />
          ) : null}

          {editErr && (
            <Alert severity="error" sx={{ mt: 1 }}>
              {editErr}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditUser(null)}>取消</Button>
          {editSection === "credits" ? (
            <Button
              variant="contained"
              onClick={() => void handleApplySingleCredits()}
              disabled={topUpSaving || (!planDays && !topUpAmount)}
            >
              应用
            </Button>
          ) : (
            <Button
              variant="contained"
              onClick={handleSaveEdit}
              disabled={editSaving}
            >
              保存
            </Button>
          )}
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
