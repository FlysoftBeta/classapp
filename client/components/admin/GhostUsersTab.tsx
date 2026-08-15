import { useState } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Alert from "@mui/material/Alert";
import CircularProgress from "@mui/material/CircularProgress";
import DeleteIcon from "@mui/icons-material/Delete";
import AddIcon from "@mui/icons-material/Add";
import {
  type AdminGhostUserRecord as GhostEntry,
  adminCreateUser,
  adminDeleteGhostUser,
  adminFetchGhostUsers,
} from "@/client/api/admin";
import { useActionQuery } from "@/client/hooks/useActionQuery";
import { AdminDataGrid, type AdminGridColumn } from "./AdminDataGrid";

export function GhostUsersTab() {
  const { data, loading, reload } = useActionQuery<{ ghosts: GhostEntry[] }>(
    () => adminFetchGhostUsers(),
    [],
  );
  const [creating, setCreating] = useState(false);
  const [latestPin, setLatestPin] = useState<string | null>(null);

  const handleCreate = async () => {
    setCreating(true);
    setLatestPin(null);
    const { res, data } = await adminCreateUser({ ghost: true });
    setCreating(false);
    if (res.ok) {
      setLatestPin("pin" in data ? (data.pin ?? null) : null);
      reload();
    }
  };

  const handleDelete = async (id: string) => {
    await adminDeleteGhostUser(id);
    reload();
  };
  const columns: AdminGridColumn<GhostEntry>[] = [
    {
      id: "id",
      label: "身份 ID",
      width: 300,
      render: (entry) => entry.id,
      longText: (entry) => entry.id,
    },
    {
      id: "created",
      label: "创建时间",
      width: 180,
      render: (entry) => entry.created_at.slice(0, 16),
    },
    {
      id: "state",
      label: "注册状态",
      width: 160,
      render: (entry) => (entry.pending_oobe ? "等待完成 OOBE" : "未使用"),
    },
    {
      id: "actions",
      label: "操作",
      width: 100,
      render: (entry) => (
        <IconButton
          size="small"
          color="error"
          title="删除待注册身份"
          onClick={() => void handleDelete(entry.id)}
        >
          <DeleteIcon fontSize="small" />
        </IconButton>
      ),
    },
  ];

  return (
    <Box>
      <Box sx={{ display: "flex", alignItems: "center", mb: 2 }}>
        <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
          干员登录后自行完成 OOBE 设置
        </Typography>
        <Button
          startIcon={<AddIcon />}
          variant="contained"
          size="small"
          onClick={handleCreate}
          disabled={creating}
        >
          {creating ? "创建中…" : "招募干员"}
        </Button>
      </Box>
      {latestPin && (
        <Alert
          severity="success"
          sx={{ mb: 2 }}
          onClose={() => setLatestPin(null)}
        >
          一次性 PIN：<b>{latestPin}</b>（请立即转告干员，关闭后不再显示）
        </Alert>
      )}
      {loading ? (
        <CircularProgress size={24} />
      ) : (
        <AdminDataGrid
          rows={data?.ghosts ?? []}
          columns={columns}
          rowKey={(entry) => entry.id}
          empty="暂无招募中干员"
          height={420}
        />
      )}
    </Box>
  );
}
