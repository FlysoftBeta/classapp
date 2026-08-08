import React, { useRef, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Fab from "@mui/material/Fab";
import TextField from "@mui/material/TextField";
import AddIcon from "@mui/icons-material/Add";
import AttachmentIcon from "@mui/icons-material/Attachment";
import CloudDownloadIcon from "@mui/icons-material/CloudDownload";
import type { Conversation } from "@/shared/types/api";
import { createArticle, createBlobArticle } from "@/client/api/articles";
import { newTaskId, taskStore } from "@/client/hooks/useTaskStore";
import { decodeUploadedText } from "@/client/lib/textEncoding";
import { NetworkArticleDialog } from "./NetworkArticleDialog";

function readFileBytes(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (!(reader.result instanceof ArrayBuffer)) {
        reject(new Error("无法读取 TXT 附件"));
        return;
      }
      resolve(new Uint8Array(reader.result));
    };
    reader.onerror = () =>
      reject(reader.error ?? new Error("无法读取 TXT 附件"));
    reader.onabort = () => reject(new Error("TXT 附件读取已取消"));
    reader.readAsArrayBuffer(file);
  });
}

export function ArticleImportFab({
  token,
  conversation,
  downloadEnabled,
  onCreated,
}: {
  token: string;
  conversation: Conversation;
  downloadEnabled: boolean;
  onCreated: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [networkOpen, setNetworkOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [attachment, setAttachment] = useState<File | null>(null);
  const [bodyFocused, setBodyFocused] = useState(false);
  const [saving, setSaving] = useState(false);

  const groupId = conversation.type === "group" ? conversation.id : null;

  const reset = () => {
    setTitle("");
    setContent("");
    setAttachment(null);
    setBodyFocused(false);
    if (inputRef.current) inputRef.current.value = "";
  };

  const close = () => {
    if (saving) return;
    setOpen(false);
    reset();
  };

  const selectFile = (file: File) => {
    if (!title.trim()) setTitle(file.name);
    setAttachment(file);
    setContent("");
    setBodyFocused(false);
  };

  const save = async () => {
    if (!groupId || !title.trim() || (!content.trim() && !attachment)) return;
    const taskId = newTaskId("article-upload");
    const total = attachment?.size ?? content.length;
    taskStore.getState().upsert({
      id: taskId,
      kind: "article-upload",
      title: title.trim(),
      status: "running",
      progress: 0,
      total,
      updatedAt: Date.now(),
    });
    setSaving(true);
    try {
      const isPdf =
        attachment &&
        (attachment.type === "application/pdf" ||
          /\.pdf$/i.test(attachment.name));
      const articleContent = isPdf
        ? ""
        : attachment
          ? decodeUploadedText(await readFileBytes(attachment)).text.trim()
          : content.trim();
      const { res } = isPdf
        ? await createBlobArticle(token, {
            title: title.trim(),
            file: attachment,
            group_id: groupId,
          })
        : await createArticle({
            title: title.trim(),
            content: articleContent,
            group_id: groupId,
          });
      if (!res.ok) throw new Error("上传失败");
      taskStore
        .getState()
        .patch(taskId, { status: "completed", progress: total });
      setOpen(false);
      reset();
      onCreated();
    } catch (error) {
      taskStore.getState().patch(taskId, {
        status: "failed",
        detail: error instanceof Error ? error.message : "上传失败",
      });
    } finally {
      setSaving(false);
    }
  };

  if (!groupId) return null;

  return (
    <>
      <Fab
        color="primary"
        aria-label="上传文章"
        onClick={() => setOpen(true)}
        sx={{ position: "fixed", right: 24, bottom: 24 }}
      >
        <AddIcon />
      </Fab>
      <Dialog open={open} onClose={close} fullWidth maxWidth="sm">
        <DialogTitle>上传到 #{conversation.name}</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            label="标题"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            sx={{ mt: 0.5, mb: 2 }}
          />
          <Box sx={{ position: "relative" }}>
            <TextField
              fullWidth
              multiline
              minRows={10}
              label="正文"
              value={content}
              disabled={Boolean(attachment)}
              onChange={(event) => setContent(event.target.value)}
              onFocus={() => setBodyFocused(true)}
              onBlur={() => setBodyFocused(false)}
              helperText={
                attachment
                  ? `已选择附件：${attachment.name}；正文已锁定`
                  : "可直接输入正文，或上传 TXT / PDF"
              }
            />
            {!content && (
              <Button
                startIcon={<AttachmentIcon />}
                onClick={() => inputRef.current?.click()}
                sx={{
                  position: "absolute",
                  left: "50%",
                  top: "50%",
                  transform: "translate(-50%, -50%)",
                  opacity: bodyFocused ? 0 : 1,
                  pointerEvents: bodyFocused ? "none" : "auto",
                  transition: "opacity 120ms ease",
                }}
              >
                {attachment ? attachment.name : "上传附件"}
              </Button>
            )}
          </Box>
          <input
            ref={inputRef}
            hidden
            type="file"
            accept=".txt,text/plain,.pdf,application/pdf"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) selectFile(file);
            }}
          />
        </DialogContent>
        <DialogActions>
          {downloadEnabled && (
            <Button
              startIcon={<CloudDownloadIcon />}
              onClick={() => {
                setOpen(false);
                setNetworkOpen(true);
              }}
            >
              从网络下载
            </Button>
          )}
          <Box sx={{ flex: 1 }} />
          <Button onClick={close} disabled={saving}>
            取消
          </Button>
          <Button
            variant="contained"
            disabled={
              saving || !title.trim() || (!content.trim() && !attachment)
            }
            onClick={() => void save()}
          >
            上传
          </Button>
        </DialogActions>
      </Dialog>
      {downloadEnabled && (
        <NetworkArticleDialog
          open={networkOpen}
          conversation={conversation}
          onClose={() => setNetworkOpen(false)}
        />
      )}
    </>
  );
}
