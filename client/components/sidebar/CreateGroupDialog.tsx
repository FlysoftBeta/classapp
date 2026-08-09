import React, { useState, useEffect } from "react";
import Typography from "@mui/material/Typography";
import Divider from "@mui/material/Divider";
import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import Switch from "@mui/material/Switch";
import FormControlLabel from "@mui/material/FormControlLabel";
import Alert from "@mui/material/Alert";
import CircularProgress from "@mui/material/CircularProgress";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import InputLabel from "@mui/material/InputLabel";
import FormControl from "@mui/material/FormControl";
import type { ConvEntry } from "@/client/hooks/useAppLogic";
import { createGroup } from "@/client/interact/groups";
import {
  DialogTitleWithHelp,
  LabelWithHelp,
} from "@/client/components/shared/HelpTip";

export function CreateGroupDialog({
  open,
  onClose,
  onCreated,
  joinedGroups,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (conv: { id: string; name: string }) => void;
  joinedGroups: ConvEntry[];
}) {
  // 1. Basic info
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  // 2. Join policy
  const [discoverable, setDiscoverable] = useState(false);
  const [parentGroupId, setParentGroupId] = useState("");
  // 3. Verification
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState("");

  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    const wild = joinedGroups.find((g) => g.handle === "wild");
    const seed = wild?.id ?? joinedGroups[0]?.id ?? "";
    // eslint-disable-next-line react-hooks/set-state-in-effect -- seed default parent once on open
    setParentGroupId((prev) => (prev ? prev : seed));
  }, [open, joinedGroups]);

  const reset = () => {
    setName("");
    setHandle("");
    setDiscoverable(false);
    setUsePassword(false);
    setPassword("");
    setError("");
  };

  const handleCreate = async () => {
    setLoading(true);
    setError("");
    const { res, data } = await createGroup({
      name,
      handle: handle.trim() || undefined,
      discoverable,
      parent_group_id: discoverable ? parentGroupId || null : null,
      password: usePassword && password ? password : undefined,
    });
    setLoading(false);
    if (!res.ok) {
      setError(data.error || "创建失败");
      return;
    }
    onCreated({ id: data.group!.id, name: data.group!.name });
    reset();
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      maxWidth="xs"
      fullWidth
    >
      <DialogTitleWithHelp help="创建一个新的群组。可设置加入方式（公开/私有）与是否需要密码验证。">
        创建群组
      </DialogTitleWithHelp>
      <DialogContent>
        {/* ── 1. 基本信息 ── */}
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: "block", mt: 1, fontWeight: 600 }}
        >
          群组基本信息
        </Typography>
        <TextField
          autoFocus
          label={
            <LabelWithHelp
              label="群组名称"
              help="展示在侧边栏与聊天顶部的群组名称。"
            />
          }
          fullWidth
          size="small"
          sx={{ mt: 1 }}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <TextField
          label={
            <LabelWithHelp
              label="Handle（可选）"
              help="群组也像干员那样拥有 handle：用于「发现群组」的精准定位，其他人可通过此 handle 找到本群。留空将自动从名称生成。"
            />
          }
          fullWidth
          size="small"
          sx={{ mt: 1.5 }}
          value={handle}
          onChange={(e) =>
            setHandle(e.target.value.replace(/[^a-zA-Z0-9_-]/g, ""))
          }
          inputProps={{ maxLength: 32 }}
          helperText="字母、数字、下划线、连字符"
        />

        <Divider sx={{ my: 2 }} />

        {/* ── 2. 加入方式 ── */}
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: "block", fontWeight: 600 }}
        >
          群组加入方式
        </Typography>
        <FormControlLabel
          control={
            <Switch
              checked={discoverable}
              onChange={(e) => setDiscoverable(e.target.checked)}
            />
          }
          label={
            <LabelWithHelp
              label="可被公开列出"
              help="勾选后，该群将在所选父群组的「发现群组」中出现，父群组成员可直接发现并加入。"
            />
          }
          sx={{ display: "block" }}
        />
        {discoverable && joinedGroups.length > 0 && (
          <FormControl fullWidth size="small" sx={{ mt: 1 }}>
            <InputLabel id="parent-group-label">挂载到父群组</InputLabel>
            <Select
              labelId="parent-group-label"
              label="挂载到父群组"
              value={parentGroupId}
              onChange={(e) => setParentGroupId(e.target.value)}
            >
              {joinedGroups.map((g) => (
                <MenuItem key={g.id} value={g.id}>
                  {g.name}
                </MenuItem>
              ))}
            </Select>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ mt: 0.5, display: "block" }}
            >
              该父群组的成员可在「发现群组」中看到本群。
            </Typography>
          </FormControl>
        )}

        <Divider sx={{ my: 2 }} />

        {/* ── 3. 验证方式 ── */}
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: "block", fontWeight: 600 }}
        >
          群组验证方式
        </Typography>
        <FormControlLabel
          control={
            <Switch
              checked={usePassword}
              onChange={(e) => setUsePassword(e.target.checked)}
            />
          }
          label={
            <LabelWithHelp
              label="需要密码"
              help="勾选后，他人加入时须提供正确密码。密码以哈希存储，无法找回。"
            />
          }
          sx={{ display: "block" }}
        />
        {usePassword && (
          <TextField
            label="密码"
            fullWidth
            size="small"
            sx={{ mt: 1 }}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        )}

        {error && (
          <Alert severity="error" sx={{ mt: 1.5 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button
          onClick={() => {
            reset();
            onClose();
          }}
        >
          取消
        </Button>
        <Button
          variant="contained"
          onClick={handleCreate}
          disabled={loading || !name.trim()}
        >
          {loading ? <CircularProgress size={16} /> : "创建"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
