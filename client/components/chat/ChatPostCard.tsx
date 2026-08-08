import React, { useState } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import IconButton from "@mui/material/IconButton";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import CircularProgress from "@mui/material/CircularProgress";
import MoreHorizIcon from "@mui/icons-material/MoreHoriz";
import ReplyIcon from "@mui/icons-material/Reply";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import type { Post, TextPost, User } from "@/shared/types/api";
import { isTextPost } from "@/shared/types/api";
import { LONG_TEXT_THRESHOLD } from "@/shared/validation/posts";
import { fetchPost, updatePost, deletePost } from "@/client/api/posts";
import { lbAssetUrl } from "@/client/lib/loadBalancer";
import { flexGap } from "@/client/lib/css";

interface ChatPostCardProps {
  post: Post;
  currentUser: User;
  onReply?: (post: Post) => void;
  onUpdated: (post: Post) => void;
  onDeleted: (post: Post) => void;
  onJumpToPost?: (postId: string) => void;
  onOpenArticle?: (articleId: string) => void;
  showGroupTag?: boolean;
  groupName?: string;
  online: boolean;
}

function formatDate(s: string) {
  const d = new Date(s.endsWith("Z") ? s : s + "Z");
  return d.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  });
}

function ContentText({ post, online }: { post: TextPost; online: boolean }) {
  const text = post.text;
  const isLong = post.is_truncated || text.length > LONG_TEXT_THRESHOLD;
  const [open, setOpen] = useState(false);
  const [fullText, setFullText] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);

  const handleOpen = async () => {
    setOpen(true);
    if (post.is_truncated && fullText === null) {
      setFetching(true);
      try {
        const { res, data } = await fetchPost(post.id);
        if (res.ok && data.post && isTextPost(data.post)) {
          setFullText(data.post.text);
        } else {
          setFullText(text);
        }
      } catch {
        setFullText(text);
      } finally {
        setFetching(false);
      }
    }
  };

  if (!isLong) {
    return (
      <Typography
        className="app-selectable"
        variant="body2"
        sx={{ mt: 0.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}
      >
        {text}
      </Typography>
    );
  }

  const previewText = text.slice(0, LONG_TEXT_THRESHOLD);
  const dialogText = post.is_truncated ? (fullText ?? text) : text;

  return (
    <Box>
      <Typography
        className="app-selectable"
        variant="body2"
        sx={{ mt: 0.5, whiteSpace: "pre-wrap", wordBreak: "break-word" }}
      >
        {previewText}…
      </Typography>
      <Button
        size="small"
        onClick={handleOpen}
        endIcon={<ExpandMoreIcon />}
        sx={{
          mt: 0.5,
          px: 0,
          fontSize: 12,
          color: "text.secondary",
          "&:hover": { bgcolor: "transparent" },
        }}
        disableRipple
        disabled={!!post.is_truncated && !online}
      >
        展开全文
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        maxWidth="md"
        fullWidth
        scroll="paper"
      >
        <DialogTitle sx={{ pb: 1 }}>完整内容</DialogTitle>
        <DialogContent dividers className="app-selectable">
          {fetching ? (
            <Box sx={{ display: "flex", justifyContent: "center", py: 3 }}>
              <CircularProgress size={28} />
            </Box>
          ) : (
            <Typography
              variant="body2"
              sx={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
            >
              {dialogText}
            </Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>关闭</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

export default function ChatPostCard({
  post,
  currentUser,
  onReply,
  onUpdated,
  onDeleted,
  onJumpToPost,
  showGroupTag,
  groupName,
  online,
}: ChatPostCardProps) {
  const initialEditText = post.type === "text" ? post.text : post.brief;

  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState(initialEditText);
  const [editLoading, setEditLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const canEdit = post.type === "text" && post.user_id === currentUser.id;
  const canDelete = post.type !== "deleted" && post.user_id === currentUser.id;

  const handleOpenEdit = async () => {
    setAnchorEl(null);
    if (post.type === "text" && post.is_truncated) {
      setEditLoading(true);
      try {
        const { res, data } = await fetchPost(post.id);
        if (res.ok && data.post && isTextPost(data.post)) {
          setEditContent(data.post.text);
        }
      } finally {
        setEditLoading(false);
      }
    }
    setEditing(true);
  };

  const handleSave = async () => {
    if (!editContent.trim()) return;
    setSaving(true);
    const { res, data } = await updatePost(post.id, editContent);
    setSaving(false);
    if (!res.ok) {
      setErr(data.error || "失败");
      return;
    }
    setEditing(false);
    onUpdated(data.post!);
  };

  const handleDelete = async () => {
    setAnchorEl(null);
    const { res, data } = await deletePost(post.id);
    if (!res.ok) {
      setErr(data.error || "失败");
      return;
    }
    onDeleted(data.post!);
  };

  if (post.type === "deleted") {
    return (
      <Box
        sx={{ px: 2, py: 1, borderBottom: "1px solid", borderColor: "divider" }}
      >
        <Typography
          variant="caption"
          sx={{ color: "text.disabled", fontStyle: "italic" }}
        >
          此内容已于{" "}
          {post.deleted_at ? formatDate(post.deleted_at) : "未知时间"} 被删除
        </Typography>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        px: 2,
        py: 1.5,
        borderBottom: "1px solid",
        borderColor: "divider",
        "&:hover": { bgcolor: "action.hover" },
        transition: "background-color 0.1s",
      }}
    >
      {post.reply_to && post.reply_brief && (
        <Box
          onClick={
            onJumpToPost && post.reply_to
              ? () => onJumpToPost(post.reply_to!)
              : undefined
          }
          sx={{
            mb: 0.5,
            pl: 1,
            borderLeft: "2px solid",
            borderColor: "primary.main",
            opacity: 0.65,
            cursor: onJumpToPost ? "pointer" : "default",
            borderRadius: "0 4px 4px 0",
            "&:hover": onJumpToPost
              ? { opacity: 1, bgcolor: "action.hover" }
              : {},
            transition: "opacity 0.15s",
          }}
        >
          <Typography variant="caption" color="text.secondary">
            @{post.reply_handle || post.reply_username || "已注销"}:{" "}
            {post.reply_brief.slice(0, 80)}
            {post.reply_brief.length > 80 ? "…" : ""}
          </Typography>
        </Box>
      )}

      <Box sx={{ display: "flex", alignItems: "flex-start" }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Box
            sx={{ display: "flex", alignItems: "baseline", flexWrap: "wrap" }}
          >
            <Typography variant="body2" fontWeight={600} sx={{ mr: 0.5 }}>
              {post.username || "无主内容"}
            </Typography>
            {post.handle && (
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ mr: 0.75 }}
              >
                @{post.handle}
              </Typography>
            )}
            {showGroupTag && groupName && (
              <Typography
                variant="caption"
                color="text.disabled"
                sx={{ mr: 0.75 }}
              >
                · #{groupName}
              </Typography>
            )}
            <Typography variant="caption" color="text.disabled">
              {formatDate(post.edited_at || post.created_at)}
              {post.edited_at && " ✎"}
            </Typography>
          </Box>

          {post.type === "sticker" && !editing && (
            <Box sx={{ mt: 1 }}>
              {post.path ? (
                <Box
                  component="img"
                  src={lbAssetUrl(post.path)}
                  alt={post.name}
                  sx={{
                    height: 150,
                    objectFit: "contain",
                    display: "block",
                  }}
                />
              ) : (
                <Typography
                  className="app-selectable"
                  variant="body2"
                  color="text.secondary"
                >
                  {post.brief}
                </Typography>
              )}
            </Box>
          )}

          {post.type === "text" && editLoading ? (
            <Box
              sx={{
                mt: 1,
                display: "flex",
                alignItems: "center",
                ...flexGap(1),
              }}
            >
              <CircularProgress size={16} />
              <Typography variant="caption" color="text.secondary">
                加载中…
              </Typography>
            </Box>
          ) : post.type === "text" && editing ? (
            <Box sx={{ mt: 1 }}>
              <TextField
                fullWidth
                multiline
                minRows={2}
                size="small"
                value={editContent}
                onChange={(e) => {
                  setEditContent(e.target.value);
                  setErr("");
                }}
                inputProps={{ maxLength: 5000000 }}
              />
              {err && (
                <Typography variant="caption" color="error">
                  {err}
                </Typography>
              )}
              <Box sx={{ mt: 0.5, display: "flex" }}>
                <Button
                  size="small"
                  variant="contained"
                  onClick={handleSave}
                  disabled={saving || !online}
                  sx={{ mr: 1 }}
                >
                  {saving ? "保存中…" : "保存"}
                </Button>
                <Button
                  size="small"
                  onClick={() => {
                    setEditing(false);
                    setEditContent(post.text);
                    setErr("");
                  }}
                >
                  取消
                </Button>
              </Box>
            </Box>
          ) : post.type === "text" ? (
            <ContentText post={post} online={online} />
          ) : null}
        </Box>

        <Box sx={{ display: "flex", ml: 1, flexShrink: 0 }}>
          {onReply && (
            <IconButton
              size="small"
              onClick={() => onReply(post)}
              sx={{ color: "text.disabled" }}
            >
              <ReplyIcon fontSize="small" />
            </IconButton>
          )}
          {(canEdit || canDelete) && (
            <IconButton
              size="small"
              onClick={(e) => setAnchorEl(e.currentTarget)}
              sx={{ color: "text.disabled" }}
              disabled={!online}
            >
              <MoreHorizIcon fontSize="small" />
            </IconButton>
          )}
        </Box>
      </Box>

      <Menu
        anchorEl={anchorEl}
        open={Boolean(anchorEl)}
        onClose={() => setAnchorEl(null)}
      >
        {canEdit && <MenuItem onClick={handleOpenEdit}>编辑</MenuItem>}
        {canDelete && (
          <MenuItem onClick={handleDelete} sx={{ color: "error.main" }}>
            删除
          </MenuItem>
        )}
      </Menu>
    </Box>
  );
}
