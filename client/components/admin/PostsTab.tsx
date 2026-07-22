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
import CircularProgress from "@mui/material/CircularProgress";
import DeleteIcon from "@mui/icons-material/Delete";
import { postPreview } from "@/shared/types/api";
import {
  type AdminPostRecord,
  adminDeletePost,
  adminFetchPosts,
} from "@/client/api/admin";
import { useActionQuery } from "@/client/hooks/useActionQuery";
export function PostsTab() {
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  const { data, loading, reload } = useActionQuery<{
    posts: AdminPostRecord[];
    total: number;
  }>(() => adminFetchPosts(q, offset), [q, offset]);

  const handleDelete = async (id: string) => {
    if (!confirm("确认永久删除该帖子（不留痕迹）？")) return;
    await adminDeletePost(id);
    reload();
  };

  return (
    <Box>
      <TextField
        size="small"
        placeholder="搜索内容…"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOffset(0);
        }}
        sx={{ mb: 2, width: "100%" }}
      />
      {loading ? (
        <CircularProgress size={24} />
      ) : (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>作者</TableCell>
              <TableCell>内容</TableCell>
              <TableCell>群组</TableCell>
              <TableCell>时间</TableCell>
              <TableCell align="right">操作</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {(data?.posts || []).map((p) => (
              <TableRow key={p.id} sx={{ opacity: p.is_deleted ? 0.4 : 1 }}>
                <TableCell sx={{ fontSize: 12 }}>{p.username || "—"}</TableCell>
                <TableCell
                  sx={{
                    maxWidth: 300,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontSize: 12,
                  }}
                >
                  {p.is_deleted ? "（已删除）" : postPreview(p)}
                </TableCell>
                <TableCell sx={{ fontSize: 12 }}>
                  {p.group_name || (p.dm_to ? "私信" : "—")}
                </TableCell>
                <TableCell sx={{ fontSize: 12 }}>
                  {p.created_at.slice(0, 16)}
                </TableCell>
                <TableCell align="right">
                  <IconButton
                    size="small"
                    color="error"
                    onClick={() => handleDelete(p.id)}
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
    </Box>
  );
}
