import React, { useRef, useState } from "react";
import SpeedDial from "@mui/material/SpeedDial";
import SpeedDialAction from "@mui/material/SpeedDialAction";
import SpeedDialIcon from "@mui/material/SpeedDialIcon";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import PictureAsPdfIcon from "@mui/icons-material/PictureAsPdf";
import ContentPasteIcon from "@mui/icons-material/ContentPaste";
import CloudDownloadIcon from "@mui/icons-material/CloudDownload";
import { createArticle, createBlobArticle } from "@/client/api/articles";
import { newTaskId, taskStore } from "@/client/hooks/useTaskStore";
import { NetworkArticleDialog } from "./NetworkArticleDialog";

export function ArticleImportFab({
  token,
  downloadEnabled,
  onCreated,
}: {
  token: string;
  downloadEnabled: boolean;
  onCreated: () => void;
}) {
  const txtRef = useRef<HTMLInputElement>(null);
  const pdfRef = useRef<HTMLInputElement>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [networkOpen, setNetworkOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");

  const runTextUpload = async (file: File) => {
    const id = newTaskId("article-upload");
    const taskTitle = file.name.replace(/\.txt$/i, "") || "TXT 文章";
    taskStore.getState().upsert({
      id,
      kind: "article-upload",
      title: taskTitle,
      status: "running",
      progress: 0,
      total: file.size,
      updatedAt: Date.now(),
    });
    try {
      const text = await file.text();
      const { res } = await createArticle({ title: taskTitle, content: text });
      if (!res.ok) throw new Error("上传失败");
      taskStore
        .getState()
        .patch(id, { status: "completed", progress: file.size });
      onCreated();
    } catch (error) {
      taskStore.getState().patch(id, {
        status: "failed",
        detail: error instanceof Error ? error.message : "上传失败",
      });
    }
  };

  const runPdfUpload = async (file: File) => {
    const id = newTaskId("article-upload");
    const taskTitle = file.name.replace(/\.pdf$/i, "") || "PDF 文章";
    taskStore.getState().upsert({
      id,
      kind: "article-upload",
      title: taskTitle,
      status: "running",
      progress: 0,
      total: file.size,
      updatedAt: Date.now(),
    });
    try {
      const { res } = await createBlobArticle(token, {
        title: taskTitle,
        file,
      });
      if (!res.ok) throw new Error("上传失败");
      taskStore
        .getState()
        .patch(id, { status: "completed", progress: file.size });
      onCreated();
    } catch (error) {
      taskStore.getState().patch(id, {
        status: "failed",
        detail: error instanceof Error ? error.message : "上传失败",
      });
    }
  };

  const saveNote = async () => {
    if (!title.trim() || !content.trim()) return;
    const id = newTaskId("article-upload");
    taskStore.getState().upsert({
      id,
      kind: "article-upload",
      title: title.trim(),
      status: "running",
      progress: 0,
      total: content.length,
      updatedAt: Date.now(),
    });
    try {
      const { res } = await createArticle({
        title: title.trim(),
        content: content.trim(),
      });
      if (!res.ok) throw new Error("保存失败");
      taskStore
        .getState()
        .patch(id, { status: "completed", progress: content.length });
      setNoteOpen(false);
      setTitle("");
      setContent("");
      onCreated();
    } catch (error) {
      taskStore.getState().patch(id, {
        status: "failed",
        detail: error instanceof Error ? error.message : "保存失败",
      });
    }
  };

  return (
    <>
      <input
        ref={txtRef}
        type="file"
        accept=".txt,text/plain"
        multiple
        hidden
        onChange={(event) => {
          for (const file of Array.from(event.target.files ?? []))
            void runTextUpload(file);
          event.target.value = "";
        }}
      />
      <input
        ref={pdfRef}
        type="file"
        accept=".pdf,application/pdf"
        multiple
        hidden
        onChange={(event) => {
          for (const file of Array.from(event.target.files ?? []))
            void runPdfUpload(file);
          event.target.value = "";
        }}
      />
      <SpeedDial
        ariaLabel="上传文章"
        icon={<SpeedDialIcon />}
        sx={{ position: "fixed", right: 24, bottom: 24 }}
      >
        <SpeedDialAction
          icon={<UploadFileIcon />}
          tooltipTitle="从本地上传 TXT"
          onClick={() => txtRef.current?.click()}
        />
        <SpeedDialAction
          icon={<PictureAsPdfIcon />}
          tooltipTitle="从本地上传 PDF"
          onClick={() => pdfRef.current?.click()}
        />
        <SpeedDialAction
          icon={<ContentPasteIcon />}
          tooltipTitle="粘贴笔记"
          onClick={() => setNoteOpen(true)}
        />
        {downloadEnabled && (
          <SpeedDialAction
            icon={<CloudDownloadIcon />}
            tooltipTitle="从网络下载"
            onClick={() => setNetworkOpen(true)}
          />
        )}
      </SpeedDial>
      <Dialog
        open={noteOpen}
        onClose={() => setNoteOpen(false)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>粘贴笔记</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            label="标题"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            sx={{ mt: 0.5, mb: 2 }}
          />
          <TextField
            fullWidth
            multiline
            minRows={10}
            label="内容"
            value={content}
            onChange={(event) => setContent(event.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setNoteOpen(false)}>取消</Button>
          <Button
            variant="contained"
            onClick={() => void saveNote()}
            disabled={!title.trim() || !content.trim()}
          >
            保存
          </Button>
        </DialogActions>
      </Dialog>
      {downloadEnabled && (
        <NetworkArticleDialog
          open={networkOpen}
          onClose={() => setNetworkOpen(false)}
        />
      )}
    </>
  );
}
