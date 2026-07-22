import { useState } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
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
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>ID</TableCell>
              <TableCell>创建时间</TableCell>
              <TableCell>状态</TableCell>
              <TableCell align="right">操作</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {(data?.ghosts || []).map((g) => (
              <TableRow key={g.id}>
                <TableCell sx={{ fontFamily: "monospace", fontSize: 11 }}>
                  {g.id.slice(0, 8)}…
                </TableCell>
                <TableCell sx={{ fontSize: 12 }}>
                  {g.created_at.slice(0, 16)}
                </TableCell>
                <TableCell sx={{ fontSize: 12 }}>
                  {g.pending_oobe ? "待激活" : "未使用"}
                </TableCell>
                <TableCell align="right">
                  <IconButton
                    size="small"
                    color="error"
                    onClick={() => handleDelete(g.id)}
                  >
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </TableCell>
              </TableRow>
            ))}
            {(data?.ghosts || []).length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={4}
                  sx={{
                    textAlign: "center",
                    color: "text.disabled",
                    fontSize: 13,
                  }}
                >
                  暂无招募中干员
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}
    </Box>
  );
}
