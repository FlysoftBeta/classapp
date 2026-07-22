import React, { useEffect } from "react";
import Popover from "@mui/material/Popover";
import Button from "@mui/material/Button";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import LinearProgress from "@mui/material/LinearProgress";
import Typography from "@mui/material/Typography";
import Box from "@mui/material/Box";
import { listNetworkArticleDownloads } from "@/client/api/articles";
import { taskStore, useTaskStore } from "@/client/store/taskStore";
import { cssMin, flexGap } from "@/client/lib/css";

const KIND_LABEL = {
  "article-upload": "文章上传",
  "network-download": "网络下载",
  "article-offline": "文章离线保存",
  "conversation-offline": "对话离线保存",
} as const;

export function TaskManagerPopover({
  anchorEl,
  onClose,
  downloadEnabled,
}: {
  anchorEl: HTMLElement | null;
  onClose: () => void;
  downloadEnabled: boolean;
}) {
  const open = Boolean(anchorEl);
  const tasks = useTaskStore((state) => state.tasks);

  useEffect(() => {
    if (!open || !downloadEnabled) return;
    let stopped = false;
    const refresh = async () => {
      const remote = await listNetworkArticleDownloads().catch(() => []);
      if (stopped) return;
      for (const task of remote) {
        taskStore.getState().upsert({
          id: task.id,
          kind: "network-download",
          title: task.title,
          status:
            task.status === "completed"
              ? "completed"
              : task.status === "failed"
                ? "failed"
                : task.status === "queued"
                  ? "queued"
                  : "running",
          progress: task.progress,
          total: task.total,
          etaMs: task.eta_ms,
          articleId: task.article_id,
          detail: task.error ?? undefined,
          updatedAt: task.updated_at,
        });
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [open, downloadEnabled]);

  return (
    <Popover
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: "top", horizontal: "right" }}
      transformOrigin={{ vertical: "bottom", horizontal: "right" }}
      slotProps={{
        paper: {
          sx: {
            width: 400,
            maxWidth: "calc(100vw - 24px)",
            ...cssMin(
              "maxHeight",
              "calc(100vh - 24px)",
              "min(560px, calc(100vh - 24px))",
            ),
            display: "flex",
            flexDirection: "column",
          },
        },
      }}
    >
      <Box sx={{ px: 2, pt: 1.5, display: "flex", alignItems: "center" }}>
        <Typography variant="subtitle1" sx={{ flex: 1, fontWeight: 600 }}>
          任务管理
        </Typography>
        <Button
          size="small"
          onClick={() => taskStore.getState().clearFinished()}
        >
          清除已完成
        </Button>
      </Box>
      <Box sx={{ overflowY: "auto", px: 1, pb: 1 }}>
        {tasks.length === 0 ? (
          <Typography color="text.secondary" variant="body2" sx={{ p: 2 }}>
            暂无任务
          </Typography>
        ) : (
          <List disablePadding>
            {tasks.map((task) => {
              const percent =
                task.total > 0
                  ? Math.min(
                      100,
                      Math.round((task.progress / task.total) * 100),
                    )
                  : 0;
              return (
                <ListItem key={task.id} divider sx={{ display: "block" }}>
                  <Box
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      ...flexGap(1),
                    }}
                  >
                    <ListItemText
                      primary={task.title}
                      secondary={`${KIND_LABEL[task.kind]} · ${task.status}${task.etaMs ? ` · 预计 ${Math.ceil(task.etaMs / 1000)} 秒` : ""}${task.detail ? ` · ${task.detail}` : ""}`}
                    />
                    {task.total > 0 && (
                      <Typography variant="caption">{percent}%</Typography>
                    )}
                  </Box>
                  {(task.status === "running" || task.status === "queued") && (
                    <LinearProgress
                      variant={task.total > 0 ? "determinate" : "indeterminate"}
                      value={percent}
                    />
                  )}
                </ListItem>
              );
            })}
          </List>
        )}
      </Box>
    </Popover>
  );
}
