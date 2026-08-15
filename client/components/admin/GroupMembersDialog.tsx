import React, { useState, useCallback, useEffect } from "react";
import Box from "@mui/material/Box";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
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
import { fetchGroupMembers } from "@/client/interact/groups";
import { flexGap } from "@/client/lib/css";
import { adminSearchUsers, adminMutateGroups } from "@/client/api/admin";
import { AdminDataGrid, type AdminGridColumn } from "./AdminDataGrid";
import { SelectionActionBar, SelectionActionIcon } from "./SelectionActionBar";
export function GroupMembersDialog({
  group,
  canManage,
  onClose,
}: {
  group: Group & { discoverable?: number; member_count: number };
  canManage: boolean;
  onClose: () => void;
}) {
  const [members, setMembers] = useState<
    { id: string; handle: string; username: string; hide_self?: number }[]
  >([]);
  const [loading, setLoading] = useState(false);
  const [addHandle, setAddHandle] = useState("");
  const [addErr, setAddErr] = useState("");
  const [adding, setAdding] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

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
    await adminMutateGroups([
      { groupId: group.id, memberAction: "remove", userId },
    ]);
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
    try {
      await adminMutateGroups([
        { groupId: group.id, memberAction: "add", userId: user.id },
      ]);
      setAdding(false);
      setAddHandle("");
      void load();
    } catch (error) {
      setAdding(false);
      setAddErr(error instanceof Error ? error.message : "失败");
    }
  };
  const selectedMembers = members.filter((member) =>
    selectedIds.has(member.id),
  );
  const handleBatchKick = async () => {
    if (!confirm(`确认将选中的 ${selectedMembers.length} 名成员移出群组？`))
      return;
    await adminMutateGroups(
      selectedMembers.map((member) => ({
        groupId: group.id,
        memberAction: "remove" as const,
        userId: member.id,
      })),
    );
    setSelectedIds(new Set());
    void load();
  };
  type Member = (typeof members)[number];
  const columns: AdminGridColumn<Member>[] = [
    {
      id: "identity",
      label: "干员",
      width: 240,
      pinned: "start",
      hideable: false,
      render: (member) => `@${member.handle}`,
      longText: (member) => `@${member.handle}\nID: ${member.id}`,
    },
    {
      id: "name",
      label: "显示名称",
      width: 200,
      render: (member) => member.username,
      longText: (member) => member.username,
    },
    {
      id: "visibility",
      label: "可见性",
      width: 150,
      render: (member) =>
        member.hide_self ? (
          <Chip
            label="隐藏成员"
            size="small"
            color="default"
            variant="outlined"
          />
        ) : (
          "正常显示"
        ),
    },
    ...(canManage
      ? [
          {
            id: "actions",
            label: "操作",
            width: 100,
            pinned: "end",
            hideable: false,
            render: (member: Member) => (
              <IconButton
                size="small"
                color="error"
                title="移出群组"
                onClick={() => void handleKick(member.id)}
              >
                <DeleteIcon fontSize="small" />
              </IconButton>
            ),
          } satisfies AdminGridColumn<Member>,
        ]
      : []),
  ];

  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>成员管理 — {group.name}</DialogTitle>
      <DialogContent>
        {canManage ? (
          <Box sx={{ display: "flex", ...flexGap(1), mb: 1.5, mt: 0.5 }}>
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
        ) : null}
        {addErr && (
          <Alert severity="error" sx={{ mb: 1 }}>
            {addErr}
          </Alert>
        )}
        {loading ? (
          <CircularProgress size={20} />
        ) : (
          <AdminDataGrid
            rows={members}
            columns={columns}
            rowKey={(member) => member.id}
            empty="暂无成员"
            height={420}
            selection={
              canManage
                ? {
                    selectedKeys: selectedIds,
                    onChange: (keys) =>
                      setSelectedIds(new Set([...keys].map(String))),
                  }
                : undefined
            }
            bulkActionBar={
              selectedMembers.length ? (
                <SelectionActionBar
                  label={`已选 ${selectedMembers.length} 名成员`}
                  onClear={() => setSelectedIds(new Set())}
                >
                  <SelectionActionIcon
                    label="移出群组"
                    color="error"
                    onClick={() => void handleBatchKick()}
                  >
                    <DeleteIcon fontSize="small" />
                  </SelectionActionIcon>
                </SelectionActionBar>
              ) : null
            }
          />
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>关闭</Button>
      </DialogActions>
    </Dialog>
  );
}
