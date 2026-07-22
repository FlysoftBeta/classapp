import React, { useState, useCallback, useEffect } from "react";
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
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import Alert from "@mui/material/Alert";
import CircularProgress from "@mui/material/CircularProgress";
import Chip from "@mui/material/Chip";
import DeleteIcon from "@mui/icons-material/Delete";
import type { Group } from "@/shared/types/api";
import { fetchGroupMembers } from "@/client/api/groups";
import {
  adminSearchUsers,
  adminAddGroupMember,
  adminRemoveGroupMember,
} from "@/client/api/admin";
export function GroupMembersDialog({
  group,
  onClose,
}: {
  group: Group & { discoverable?: number; member_count: number };
  onClose: () => void;
}) {
  const [members, setMembers] = useState<
    { id: string; handle: string; username: string; hide_self?: number }[]
  >([]);
  const [loading, setLoading] = useState(false);
  const [addHandle, setAddHandle] = useState("");
  const [addErr, setAddErr] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const d = await fetchGroupMembers(group.id);
    setLoading(false);
    if (d) {
      setMembers(d.members ?? []);
    }
  }, [group.id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount fetch for dialog
    void load();
  }, [load]);

  const handleKick = async (userId: string) => {
    if (!confirm("确认踢出该成员？")) return;
    await adminRemoveGroupMember(group.id, userId);
    load();
  };

  const handleAdd = async () => {
    if (!addHandle.trim()) return;
    setAdding(true);
    setAddErr("");
    const userData = await adminSearchUsers(addHandle.trim());
    const user = (userData?.users ?? []).find(
      (u) => u.handle.toLowerCase() === addHandle.trim().toLowerCase(),
    );
    if (!user) {
      setAddErr("找不到该干员");
      setAdding(false);
      return;
    }
    const { res, data } = await adminAddGroupMember(group.id, user.id);
    setAdding(false);
    if (res.ok) {
      setAddHandle("");
      load();
    } else {
      setAddErr(data.error || "失败");
    }
  };

  return (
    <Dialog open onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>成员管理 — {group.name}</DialogTitle>
      <DialogContent>
        <Box sx={{ display: "flex", gap: 1, mb: 1.5, mt: 0.5 }}>
          <TextField
            size="small"
            placeholder="输入 @handle 强制加入"
            value={addHandle}
            onChange={(e) => {
              setAddHandle(e.target.value);
              setAddErr("");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAdd();
            }}
            sx={{ flex: 1 }}
          />
          <Button
            size="small"
            variant="outlined"
            onClick={handleAdd}
            disabled={adding || !addHandle.trim()}
          >
            加入
          </Button>
        </Box>
        {addErr && (
          <Alert severity="error" sx={{ mb: 1 }}>
            {addErr}
          </Alert>
        )}
        {loading ? (
          <CircularProgress size={20} />
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>干员</TableCell>
                <TableCell>状态</TableCell>
                <TableCell align="right">操作</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {members.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>
                    <Typography variant="body2" fontWeight={500}>
                      {m.username}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      @{m.handle}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    {!!m.hide_self && (
                      <Chip
                        label="隐藏成员"
                        size="small"
                        color="default"
                        variant="outlined"
                      />
                    )}
                  </TableCell>
                  <TableCell align="right">
                    <IconButton
                      size="small"
                      color="error"
                      onClick={() => handleKick(m.id)}
                    >
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>关闭</Button>
      </DialogActions>
    </Dialog>
  );
}
