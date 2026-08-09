import React, { useEffect, useState } from "react";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import CircularProgress from "@mui/material/CircularProgress";
import { flexGap } from "@/client/lib/css";
import {
  searchNetworkArticles,
  startNetworkArticleDownload,
} from "@/client/interact/articles";
import { taskStore } from "@/client/hooks/useTaskStore";
import type { Conversation } from "@/shared/types/api";

type Result =
  Awaited<ReturnType<typeof searchNetworkArticles>> extends infer R
    ? R extends { status: "ready"; results: infer T }
      ? T extends Array<infer I>
        ? I
        : never
      : never
    : never;

export function NetworkArticleDialog({
  open,
  conversation,
  onClose,
}: {
  open: boolean;
  conversation: Conversation;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [readyAt, setReadyAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!readyAt) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [readyAt]);

  const search = async () => {
    if (!query.trim() || loading) return;
    setLoading(true);
    setError("");
    setReadyAt(0);
    try {
      const data = await searchNetworkArticles(query.trim());
      if (!data) {
        setError("搜索失败");
        return;
      }
      if (data.status === "busy") {
        setReadyAt(data.ready_at);
        setNow(Date.now());
        return;
      }
      setResults(data.results);
    } catch {
      setError("搜索失败");
    } finally {
      setLoading(false);
    }
  };

  const download = async (item: Result) => {
    if (conversation.type !== "group") return;
    const task = await startNetworkArticleDownload(
      item.book_id,
      conversation.id,
      item.title,
    );
    if (!task) {
      setError("创建下载任务失败");
      return;
    }
    taskStore.getState().upsert({
      id: task.id,
      kind: "network-download",
      title: task.title,
      status:
        task.status === "failed"
          ? "failed"
          : task.status === "completed"
            ? "completed"
            : "running",
      progress: task.progress,
      total: task.total,
      etaMs: task.eta_ms,
      detail: task.error ?? undefined,
      articleId: task.article_id,
      updatedAt: task.updated_at,
    });
  };

  const seconds = Math.max(0, Math.ceil((readyAt - now) / 1000));
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>从网络下载文章</DialogTitle>
      <DialogContent>
        <Box sx={{ display: "flex", ...flexGap(1), mt: 0.5 }}>
          <TextField
            autoFocus
            fullWidth
            size="small"
            label="书名或作者"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void search();
            }}
          />
          <Button
            variant="contained"
            onClick={() => void search()}
            disabled={loading || !query.trim() || readyAt > now}
          >
            {loading ? <CircularProgress size={18} /> : "搜索"}
          </Button>
        </Box>
        {readyAt > now && (
          <Typography color="warning.main" variant="body2" sx={{ mt: 2 }}>
            搜索 Client 正在冷却，预计等待 {seconds} 秒。到时可立即重试。
          </Typography>
        )}
        {error && (
          <Typography color="error" variant="body2" sx={{ mt: 2 }}>
            {error}
          </Typography>
        )}
        <List disablePadding sx={{ mt: 1 }}>
          {results.map((item) => (
            <ListItem
              key={`${item.source}:${item.book_id}`}
              divider
              secondaryAction={
                <Button size="small" onClick={() => void download(item)}>
                  下载
                </Button>
              }
            >
              <ListItemText
                primary={item.title}
                secondary={`${item.author ?? "未知作者"}${item.abstract ? ` · ${item.abstract.slice(0, 80)}` : ""}`}
              />
            </ListItem>
          ))}
        </List>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>关闭</Button>
      </DialogActions>
    </Dialog>
  );
}
