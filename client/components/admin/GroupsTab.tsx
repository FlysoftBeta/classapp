import { useState } from "react";
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
import Switch from "@mui/material/Switch";
import FormControlLabel from "@mui/material/FormControlLabel";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import Select from "@mui/material/Select";
import MenuItem from "@mui/material/MenuItem";
import Alert from "@mui/material/Alert";
import CircularProgress from "@mui/material/CircularProgress";
import Chip from "@mui/material/Chip";
import DeleteIcon from "@mui/icons-material/Delete";
import EditIcon from "@mui/icons-material/Edit";
import AddIcon from "@mui/icons-material/Add";
import {
  type AdminGroupRecord,
  adminFetchGroups,
  adminCreateGroup,
  adminUpdateGroup,
  adminDeleteGroup,
} from "@/client/api/admin";
import {
  DialogTitleWithHelp,
  LabelWithHelp,
} from "@/client/components/shared/HelpTip";
import { useActionQuery } from "@/client/hooks/useActionQuery";
import { GroupMembersDialog } from "./GroupMembersDialog";

const GROUP_TYPE_LABELS: Record<string, string> = {
  normal: "普通",
  wild: "大别野",
  announcement: "公告群",
};

export function GroupsTab() {
  const [offset, setOffset] = useState(0);
  const { data, loading, reload } = useActionQuery<{
    groups: AdminGroupRecord[];
    total: number;
  }>(() => adminFetchGroups(offset), [offset]);

  const [createOpen, setCreateOpen] = useState(false);
  const [newHandle, setNewHandle] = useState("");
  const [newName, setNewName] = useState("");
  const [newUsePassword, setNewUsePassword] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [newType, setNewType] = useState("normal");
  const [newDiscoverable, setNewDiscoverable] = useState(false);
  const [newMembersHidden, setNewMembersHidden] = useState(false);
  const [newAdminOnly, setNewAdminOnly] = useState(false);
  const [newNoLeave, setNewNoLeave] = useState(false);
  const [newParentGroupId, setNewParentGroupId] = useState("");
  const [createErr, setCreateErr] = useState("");
  const [creating, setCreating] = useState(false);

  const [editGroup, setEditGroup] = useState<AdminGroupRecord | null>(null);
  const [editHandle, setEditHandle] = useState("");
  const [editName, setEditName] = useState("");
  const [editUsePassword, setEditUsePassword] = useState(false);
  const [editPassword, setEditPassword] = useState("");
  const [editClearPassword, setEditClearPassword] = useState(false);
  const [editType, setEditType] = useState("normal");
  const [editDiscoverable, setEditDiscoverable] = useState(false);
  const [editMembersHidden, setEditMembersHidden] = useState(false);
  const [editAdminOnly, setEditAdminOnly] = useState(false);
  const [editNoLeave, setEditNoLeave] = useState(false);
  const [editParentGroupId, setEditParentGroupId] = useState("");
  const [editErr, setEditErr] = useState("");
  const [editSaving, setEditSaving] = useState(false);

  const [membersGroup, setMembersGroup] = useState<AdminGroupRecord | null>(
    null,
  );

  const openCreate = () => {
    const wild = data?.groups.find((g) => g.type === "wild");
    setNewParentGroupId(wild?.id ?? "");
    setCreateOpen(true);
  };

  const resetCreate = () => {
    setNewHandle("");
    setNewName("");
    setNewUsePassword(false);
    setNewPassword("");
    setNewType("normal");
    setNewDiscoverable(false);
    setNewMembersHidden(false);
    setNewAdminOnly(false);
    setNewNoLeave(false);
    setNewParentGroupId("");
    setCreateErr("");
  };

  const handleCreate = async () => {
    setCreating(true);
    setCreateErr("");
    const { res, data } = await adminCreateGroup({
      handle: newHandle.trim() || undefined,
      name: newName,
      password: newUsePassword && newPassword ? newPassword : undefined,
      type: newType,
      discoverable: newDiscoverable,
      members_hidden: newMembersHidden,
      admin_only: newAdminOnly,
      no_leave: newNoLeave,
      parent_group_id:
        newType === "normal" && newDiscoverable
          ? newParentGroupId || null
          : null,
    });
    setCreating(false);
    if (!res.ok) {
      setCreateErr(("error" in data && data.error) || "失败");
      return;
    }
    setCreateOpen(false);
    resetCreate();
    reload();
  };

  const handleEdit = async () => {
    if (!editGroup) return;
    setEditSaving(true);
    setEditErr("");
    const isSystemGroup =
      editGroup.type === "wild" || editGroup.type === "announcement";
    const body: Record<string, unknown> = {
      handle: editHandle,
      name: editName,
      discoverable: editDiscoverable,
      members_hidden: editMembersHidden,
      admin_only: editAdminOnly,
      no_leave: editNoLeave,
    };
    if (!isSystemGroup) body.type = editType;
    if (!isSystemGroup) body.parent_group_id = editParentGroupId || null;
    if (editClearPassword) body.clearPassword = true;
    else if (editUsePassword && editPassword) body.password = editPassword;
    const { res, data } = await adminUpdateGroup(editGroup.id, body);
    setEditSaving(false);
    if (!res.ok) {
      setEditErr(("error" in data && data.error) || "失败");
      return;
    }
    setEditGroup(null);
    reload();
  };

  const handleDelete = async (id: string) => {
    if (!confirm("确认删除该群组？")) return;
    await adminDeleteGroup(id);
    reload();
  };

  const openEdit = (g: AdminGroupRecord) => {
    setEditGroup(g);
    setEditHandle(g.handle ?? g.id);
    setEditName(g.name);
    setEditUsePassword(false);
    setEditPassword("");
    setEditClearPassword(false);
    setEditType(g.type || "normal");
    setEditDiscoverable(!!g.discoverable);
    setEditMembersHidden(!!g.members_hidden);
    setEditAdminOnly(!!g.admin_only);
    setEditNoLeave(!!g.no_leave);
    setEditParentGroupId(g.parent_group_id ?? "");
    setEditErr("");
  };

  return (
    <Box>
      <Box sx={{ mb: 2 }}>
        <Button
          startIcon={<AddIcon />}
          variant="contained"
          size="small"
          onClick={openCreate}
        >
          新建群组
        </Button>
      </Box>
      {loading ? (
        <CircularProgress size={24} />
      ) : (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Handle</TableCell>
              <TableCell>名称</TableCell>
              <TableCell>类型</TableCell>
              <TableCell>成员数</TableCell>
              <TableCell>属性</TableCell>
              <TableCell align="right">操作</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {(data?.groups || []).map((g) => (
              <TableRow key={g.id}>
                <TableCell sx={{ fontFamily: "monospace", fontSize: 12 }}>
                  {g.handle ?? g.id}
                </TableCell>
                <TableCell>{g.name}</TableCell>
                <TableCell>
                  <Chip
                    label={GROUP_TYPE_LABELS[g.type || "normal"] ?? g.type}
                    size="small"
                    color={
                      g.type === "wild"
                        ? "warning"
                        : g.type === "announcement"
                          ? "info"
                          : "default"
                    }
                  />
                </TableCell>
                <TableCell>
                  <Button
                    size="small"
                    variant="text"
                    sx={{ minWidth: 0, fontSize: 12 }}
                    onClick={() => setMembersGroup(g)}
                  >
                    {(g as { member_count?: number }).member_count ?? 0} 人
                  </Button>
                </TableCell>
                <TableCell>
                  {!!g.discoverable && (
                    <Chip
                      label="可发现"
                      size="small"
                      color="success"
                      sx={{ mr: 0.5 }}
                    />
                  )}
                  {!!g.members_hidden && (
                    <Chip label="隐藏成员" size="small" sx={{ mr: 0.5 }} />
                  )}
                  {!!g.admin_only && (
                    <Chip label="仅管理员发言" size="small" sx={{ mr: 0.5 }} />
                  )}
                  {!!g.no_leave && <Chip label="禁止退出" size="small" />}
                </TableCell>
                <TableCell align="right">
                  <IconButton size="small" onClick={() => openEdit(g)}>
                    <EditIcon fontSize="small" />
                  </IconButton>
                  {g.type !== "wild" && g.type !== "announcement" && (
                    <IconButton
                      size="small"
                      color="error"
                      onClick={() => handleDelete(g.id)}
                    >
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  )}
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

      {/* Create dialog */}
      <Dialog
        open={createOpen}
        onClose={() => {
          resetCreate();
          setCreateOpen(false);
        }}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitleWithHelp help="创建一个新群组。群组的内部 id 由系统自动分配，用户可见 handle 用于在「发现群组」中定位。">
          新建群组
        </DialogTitleWithHelp>
        <DialogContent>
          {/* 基本信息 */}
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ fontWeight: 600, display: "block", mt: 1 }}
          >
            群组基本信息
          </Typography>
          <TextField
            autoFocus
            label={
              <LabelWithHelp
                label="群组名称"
                help="侧边栏展示与聊天页头部使用的名称。"
              />
            }
            fullWidth
            size="small"
            sx={{ mt: 1 }}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <TextField
            label={
              <LabelWithHelp
                label="Handle（可选）"
                help="群组的用户可见标识，类似干员 @handle。留空将根据名称生成。"
              />
            }
            fullWidth
            size="small"
            sx={{ mt: 1.5 }}
            value={newHandle}
            onChange={(e) =>
              setNewHandle(e.target.value.replace(/[^a-zA-Z0-9_-]/g, ""))
            }
            helperText="仅限字母、数字、下划线、连字符"
            inputProps={{ maxLength: 32 }}
          />
          <Select
            fullWidth
            size="small"
            sx={{ mt: 1.5 }}
            value={newType}
            onChange={(e) => {
              const t = e.target.value;
              setNewType(t);
              if (t === "wild" || t === "announcement") setNewNoLeave(true);
            }}
          >
            <MenuItem value="normal">普通</MenuItem>
            <MenuItem value="wild">大别野（顶替现有）</MenuItem>
            <MenuItem value="announcement">公告群（顶替现有）</MenuItem>
          </Select>

          {/* 加入方式 */}
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ fontWeight: 600, display: "block", mt: 2 }}
          >
            群组加入方式
          </Typography>
          {newType === "normal" && (
            <FormControlLabel
              control={
                <Switch
                  checked={newDiscoverable}
                  onChange={(e) => setNewDiscoverable(e.target.checked)}
                />
              }
              label={
                <LabelWithHelp
                  label="可被公开列出"
                  help="勾选后该群将在所选父群组的「发现群组」中可见，父群组成员可直接加入。"
                />
              }
              sx={{ display: "block" }}
            />
          )}
          {newDiscoverable &&
            newType === "normal" &&
            (data?.groups?.length ?? 0) > 0 && (
              <FormControl fullWidth size="small" sx={{ mt: 1 }}>
                <InputLabel>挂载到父群组</InputLabel>
                <Select
                  label="挂载到父群组"
                  value={newParentGroupId}
                  onChange={(e) => setNewParentGroupId(e.target.value)}
                >
                  <MenuItem value="">不关联</MenuItem>
                  {(data?.groups || []).map((g) => (
                    <MenuItem key={g.id} value={g.id}>
                      {g.name} (@{g.handle ?? g.id})
                    </MenuItem>
                  ))}
                </Select>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ mt: 0.5, display: "block" }}
                >
                  父群组的成员可在「发现群组」中看到本群。
                </Typography>
              </FormControl>
            )}
          <FormControlLabel
            control={
              <Switch
                checked={newMembersHidden}
                onChange={(e) => setNewMembersHidden(e.target.checked)}
              />
            }
            label={
              <LabelWithHelp
                label="成员列表不可见"
                help="非管理员无法查看本群成员列表。"
              />
            }
            sx={{ display: "block" }}
          />
          <FormControlLabel
            control={
              <Switch
                checked={newAdminOnly}
                onChange={(e) => setNewAdminOnly(e.target.checked)}
              />
            }
            label={
              <LabelWithHelp
                label="仅管理员可发言"
                help="普通成员仅能浏览，无法发送消息或文章。"
              />
            }
            sx={{ display: "block" }}
          />
          <FormControlLabel
            control={
              <Switch
                checked={newNoLeave}
                onChange={(e) => setNewNoLeave(e.target.checked)}
              />
            }
            label={
              <LabelWithHelp
                label="禁止退出"
                help="成员无法主动退出该群（只有管理员可移除）。"
              />
            }
            sx={{ display: "block" }}
          />

          {/* 验证方式 */}
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ fontWeight: 600, display: "block", mt: 2 }}
          >
            群组验证方式
          </Typography>
          <FormControlLabel
            control={
              <Switch
                checked={newUsePassword}
                onChange={(e) => setNewUsePassword(e.target.checked)}
              />
            }
            label={
              <LabelWithHelp
                label="需要密码"
                help="加入时需提供正确密码。密码以哈希存储，无法找回。"
              />
            }
            sx={{ display: "block" }}
          />
          {newUsePassword && (
            <TextField
              label="密码"
              fullWidth
              size="small"
              sx={{ mt: 1 }}
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          )}
          {createErr && (
            <Alert severity="error" sx={{ mt: 1 }}>
              {createErr}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              resetCreate();
              setCreateOpen(false);
            }}
          >
            取消
          </Button>
          <Button
            variant="contained"
            onClick={handleCreate}
            disabled={creating || !newName.trim()}
          >
            {creating ? <CircularProgress size={16} /> : "创建"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Edit dialog */}
      <Dialog
        open={!!editGroup}
        onClose={() => setEditGroup(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitleWithHelp help="修改群组配置。改动 handle 不会影响内部 id 与历史数据。">
          {`编辑群组 — @${editGroup?.handle ?? editGroup?.id ?? ""}`}
        </DialogTitleWithHelp>
        <DialogContent>
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ fontWeight: 600, display: "block", mt: 1 }}
          >
            群组基本信息
          </Typography>
          <TextField
            autoFocus
            label={
              <LabelWithHelp label="群组名称" help="对外显示的群组名称。" />
            }
            fullWidth
            size="small"
            sx={{ mt: 1 }}
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
          />
          <TextField
            label={
              <LabelWithHelp
                label="Handle"
                help="群组的用户可见标识（类似 @handle）。"
              />
            }
            fullWidth
            size="small"
            sx={{ mt: 1.5 }}
            value={editHandle}
            onChange={(e) =>
              setEditHandle(e.target.value.replace(/[^a-zA-Z0-9_-]/g, ""))
            }
            inputProps={{ maxLength: 32 }}
          />
          {editGroup?.type === "wild" || editGroup?.type === "announcement" ? (
            <Box sx={{ mt: 1.5 }}>
              <Typography variant="caption" color="text.secondary">
                群组类型
              </Typography>
              <Box sx={{ mt: 0.5 }}>
                <Chip
                  label={GROUP_TYPE_LABELS[editGroup.type] ?? editGroup.type}
                  size="small"
                  color={editGroup.type === "wild" ? "warning" : "info"}
                />
              </Box>
            </Box>
          ) : (
            <Select
              fullWidth
              size="small"
              sx={{ mt: 1.5 }}
              value={editType}
              onChange={(e) => {
                const t = e.target.value;
                setEditType(t);
                if (t === "wild" || t === "announcement") setEditNoLeave(true);
              }}
            >
              <MenuItem value="normal">普通</MenuItem>
              <MenuItem value="wild">大别野（顶替现有）</MenuItem>
              <MenuItem value="announcement">公告群（顶替现有）</MenuItem>
            </Select>
          )}
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ fontWeight: 600, display: "block", mt: 2 }}
          >
            群组加入方式
          </Typography>
          {editGroup &&
            editGroup.type !== "wild" &&
            editGroup.type !== "announcement" && (
              <FormControlLabel
                control={
                  <Switch
                    checked={editDiscoverable}
                    onChange={(e) => setEditDiscoverable(e.target.checked)}
                  />
                }
                label={
                  <LabelWithHelp
                    label="可被公开列出"
                    help="勾选后将在所选父群组的「发现群组」中出现。"
                  />
                }
                sx={{ display: "block" }}
              />
            )}
          {editGroup &&
            editGroup.type !== "wild" &&
            editGroup.type !== "announcement" &&
            editDiscoverable && (
              <FormControl fullWidth size="small" sx={{ mt: 1.5 }}>
                <InputLabel>挂载到父群组</InputLabel>
                <Select
                  label="挂载到父群组"
                  value={editParentGroupId}
                  onChange={(e) => setEditParentGroupId(e.target.value)}
                >
                  <MenuItem value="">不关联</MenuItem>
                  {(data?.groups || [])
                    .filter((g) => g.id !== editGroup.id)
                    .map((g) => (
                      <MenuItem key={g.id} value={g.id}>
                        {g.name} (@{g.handle ?? g.id})
                      </MenuItem>
                    ))}
                </Select>
              </FormControl>
            )}
          <FormControlLabel
            control={
              <Switch
                checked={editMembersHidden}
                onChange={(e) => setEditMembersHidden(e.target.checked)}
              />
            }
            label={
              <LabelWithHelp
                label="成员列表不可见"
                help="非管理员无法查看本群成员列表。"
              />
            }
            sx={{ display: "block" }}
          />
          <FormControlLabel
            control={
              <Switch
                checked={editAdminOnly}
                onChange={(e) => setEditAdminOnly(e.target.checked)}
              />
            }
            label={
              <LabelWithHelp label="仅管理员可发言" help="普通成员仅能浏览。" />
            }
            sx={{ display: "block" }}
          />
          <FormControlLabel
            control={
              <Switch
                checked={editNoLeave}
                onChange={(e) => setEditNoLeave(e.target.checked)}
              />
            }
            label={
              <LabelWithHelp label="禁止退出" help="成员无法主动退出该群。" />
            }
            sx={{ display: "block" }}
          />

          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ fontWeight: 600, display: "block", mt: 2 }}
          >
            群组验证方式
          </Typography>
          {editGroup?.has_password ? (
            <FormControlLabel
              control={
                <Switch
                  checked={editClearPassword}
                  onChange={(e) => {
                    setEditClearPassword(e.target.checked);
                    if (e.target.checked) setEditUsePassword(false);
                  }}
                />
              }
              label={
                <LabelWithHelp
                  label="清除现有密码"
                  help="切换后任何人均可直接加入。"
                />
              }
              sx={{ display: "block" }}
            />
          ) : null}
          {!editClearPassword && (
            <FormControlLabel
              control={
                <Switch
                  checked={editUsePassword}
                  onChange={(e) => setEditUsePassword(e.target.checked)}
                />
              }
              label={
                <LabelWithHelp
                  label={editGroup?.has_password ? "修改密码" : "设置密码"}
                  help="加入时需提供正确密码。"
                />
              }
              sx={{ display: "block" }}
            />
          )}
          {editUsePassword && !editClearPassword && (
            <TextField
              label="新密码"
              fullWidth
              size="small"
              sx={{ mt: 1 }}
              type="password"
              value={editPassword}
              onChange={(e) => setEditPassword(e.target.value)}
            />
          )}
          {editErr && (
            <Alert severity="error" sx={{ mt: 1 }}>
              {editErr}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditGroup(null)}>取消</Button>
          <Button
            variant="contained"
            onClick={handleEdit}
            disabled={editSaving || !editName.trim()}
          >
            {editSaving ? <CircularProgress size={16} /> : "保存"}
          </Button>
        </DialogActions>
      </Dialog>

      {membersGroup && (
        <GroupMembersDialog
          group={membersGroup}
          onClose={() => setMembersGroup(null)}
        />
      )}
    </Box>
  );
}
