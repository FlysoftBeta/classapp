import React, { useState, useRef, useEffect, useCallback } from "react";
import { alpha } from "@mui/material/styles";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import IconButton from "@mui/material/IconButton";
import TextField from "@mui/material/TextField";
import CircularProgress from "@mui/material/CircularProgress";
import Tooltip from "@mui/material/Tooltip";
import Dialog from "@mui/material/Dialog";
import Chip from "@mui/material/Chip";
import SendIcon from "@mui/icons-material/Send";
import ReplyIcon from "@mui/icons-material/Reply";
import OpenInFullIcon from "@mui/icons-material/OpenInFull";
import CloseFullscreenIcon from "@mui/icons-material/CloseFullscreen";
import ImageIcon from "@mui/icons-material/Image";
import type {
  User,
  StickerRecentItem,
} from "@/shared/types/api";
import type { Conversation, Post } from "@/client/interact/presentation";
import type { UserConfigChangedEvent } from "@/client/hooks/useAppLogic";
import { createPost, type CreatePostBody } from "@/client/interact/posts";
import { uploadPostImage } from "@/client/interact/postImages";
import { sendStickerPost } from "@/client/api/stickers";
import {
  fetchConversationDraft,
  saveConversationDraft,
} from "@/client/interact/conversations";
import { StickerPicker } from "@/client/components/chat/StickerPicker";
import { parseDbTime } from "@/shared/time";
import { hasFeature } from "@/shared/features";

function isPostingRestricted(conv: Conversation, user: User): boolean {
  return (
    conv.type === "group" && !!conv.admin_only && !user.administration.available
  );
}

// ── Compose bar ───────────────────────────────────────────────────────────────
export function MessageComposeBar({
  currentUser,
  conversation,
  replyTo,
  onClearReply,
  onPosted,
  subscribeConfigEvents,
  rootRef,
  online,
}: {
  currentUser: User;
  token: string;
  conversation: Conversation;
  replyTo: Post | null;
  onClearReply: () => void;
  onPosted: (post: Post) => void;
  subscribeConfigEvents?: (
    fn: (evt: UserConfigChangedEvent) => void,
  ) => () => void;
  rootRef?: React.Ref<HTMLDivElement>;
  online: boolean;
  articlesEnabled: boolean;
}) {
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [expiredMuteKey, setExpiredMuteKey] = useState<string | null>(null);
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const skipDraftSaveRef = useRef(true);
  const draftConvKeyRef = useRef("");
  const contentRef = useRef("");
  const imageInputRef = useRef<HTMLInputElement>(null);
  const prevConvRef = useRef<{ type: "group" | "dm"; id: string } | null>(null);

  const convKey = `${conversation.type}:${conversation.id}`;

  useEffect(() => {
    if (!currentUser.is_muted || !currentUser.muted_until) return;
    const muteKey = `${currentUser.id}:${currentUser.muted_until}`;
    const until = parseDbTime(currentUser.muted_until).getTime();
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const remaining = until - Date.now();
      if (remaining <= 0) {
        setExpiredMuteKey(muteKey);
        return;
      }
      timer = setTimeout(schedule, Math.min(remaining, 2_147_000_000));
    };
    timer = setTimeout(schedule, 0);
    return () => clearTimeout(timer);
  }, [currentUser.id, currentUser.is_muted, currentUser.muted_until]);

  useEffect(() => {
    contentRef.current = content;
  }, [content]);

  const persistDraft = useCallback(
    (draft: string) => {
      void saveConversationDraft({
        type: conversation.type,
        id: conversation.id,
        draft,
      });
    },
    [conversation.type, conversation.id],
  );

  useEffect(() => {
    let cancelled = false;
    const prev = prevConvRef.current;
    if (prev && !skipDraftSaveRef.current) {
      void saveConversationDraft({
        type: prev.type,
        id: prev.id,
        draft: contentRef.current,
      });
    }
    prevConvRef.current = { type: conversation.type, id: conversation.id };
    skipDraftSaveRef.current = true;
    void (async () => {
      if (cancelled) return;
      setContent("");
      const draft = await fetchConversationDraft({
        type: conversation.type,
        id: conversation.id,
      });
      if (cancelled) return;
      setContent(draft);
      draftConvKeyRef.current = convKey;
      skipDraftSaveRef.current = false;
    })();
    return () => {
      cancelled = true;
    };
  }, [convKey, conversation.type, conversation.id]);

  useEffect(() => {
    if (skipDraftSaveRef.current || draftConvKeyRef.current !== convKey) {
      return;
    }
    const timer = setTimeout(() => {
      persistDraft(content);
    }, 400);
    return () => clearTimeout(timer);
  }, [content, convKey, persistDraft]);

  const sendPost = async (
    text: string,
    opts?: {
      title?: string;
      articleContent?: string;
      attachReply?: boolean;
    },
  ): Promise<boolean> => {
    if (!online) return false;
    if (!text.trim()) return false;

    try {
      const body: CreatePostBody = {
        content: text.trim(),
        conv_id: conversation.conv_id,
      };
      if (opts?.attachReply && replyTo) body.reply_to = replyTo.id;

      const { res, data } = await createPost(body);
      if (!res.ok || !("post" in data) || !data.post) {
        setError(("error" in data && data.error) || "发送失败");
        return false;
      }
      onPosted(data.post);
      return true;
    } catch {
      setError("发送失败");
      return false;
    }
  };

  const clearCompose = () => {
    setContent("");
    onClearReply();
    persistDraft("");
  };

  const handlePost = async () => {
    if (!online || loading || !content.trim()) return;
    setLoading(true);
    setError("");
    try {
      if (await sendPost(content, { attachReply: true })) clearCompose();
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !fullscreenOpen) {
      e.preventDefault();
      handlePost();
    }
  };

  const composePlaceholder = !online
    ? "离线草稿（会自动保存）"
    : conversation.type === "dm"
      ? `发消息给 @${conversation.name}…`
      : "发送消息…";

  const handleComposeChange = (value: string) => {
    setContent(value);
    setError("");
  };

  const canSend = online && content.trim().length > 0;

  const handleStickerPick = (item: StickerRecentItem) => {
    if (loading || !online) return;
    setError("");
    setLoading(true);
    void (async () => {
      try {
        const body = {
          content: {
            type: "sticker" as const,
            sticker_pack: item.pack,
            sticker_id: item.id,
          },
          conv_id: conversation.conv_id,
          ...(replyTo ? { reply_to: replyTo.id } : {}),
        };
        const { res, data } = await sendStickerPost(body);
        if (!res.ok || !("post" in data) || !data.post) {
          setError(("error" in data && data.error) || "发送贴纸失败");
          return;
        }
        onPosted(data.post);
        onClearReply();
      } catch {
        setError("发送贴纸失败");
      } finally {
        setLoading(false);
      }
    })();
  };

  const handleImagePick = (file: File | undefined) => {
    if (!file || loading || !online) return;
    setError("");
    setLoading(true);
    void (async () => {
      try {
        const { res, data } = await uploadPostImage({
          file,
          conv_id: conversation.conv_id,
          ...(replyTo ? { reply_to: replyTo.id } : {}),
        });
        if (!res.ok || !("post" in data) || !data.post) {
          setError(("error" in data && data.error) || "发送图片失败");
          return;
        }
        onPosted(data.post);
        onClearReply();
      } catch {
        setError("发送图片失败");
      } finally {
        setLoading(false);
      }
    })();
  };

  const muted =
    !!currentUser.is_muted &&
    (!currentUser.muted_until ||
      expiredMuteKey !== `${currentUser.id}:${currentUser.muted_until}`);

  if (muted) {
    return (
      <Box
        ref={rootRef}
        sx={(theme) => ({
          px: 2,
          py: 1.5,
          borderTop: "1px solid",
          borderColor: "divider",
          bgcolor: alpha(theme.palette.background.paper, 0.72),
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          position: "sticky",
          bottom: 0,
          zIndex: 20,
        })}
      >
        <Typography variant="body2" color="text.disabled">
          你已被禁言
        </Typography>
      </Box>
    );
  }

  if (isPostingRestricted(conversation, currentUser)) {
    return (
      <Box
        ref={rootRef}
        sx={(theme) => ({
          px: 2,
          py: 1.5,
          borderTop: "1px solid",
          borderColor: "divider",
          bgcolor: alpha(theme.palette.background.paper, 0.72),
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
          position: "sticky",
          bottom: 0,
          zIndex: 20,
        })}
      >
        <Typography variant="body2" color="text.disabled">
          该群组仅管理员可以发言
        </Typography>
      </Box>
    );
  }

  return (
    <Box
      ref={rootRef}
      sx={(theme) => ({
        px: 2,
        py: 1,
        borderTop: "1px solid",
        borderColor: "divider",
        bgcolor: alpha(theme.palette.background.paper, 0.72),
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        position: "sticky",
        bottom: 0,
        zIndex: 20,
      })}
    >
      {replyTo && (
        <Box sx={{ display: "flex", alignItems: "center", mb: 0.5 }}>
          <ReplyIcon
            sx={{
              fontSize: 14,
              mr: 0.5,
              color: "text.secondary",
              flexShrink: 0,
            }}
          />
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ flex: 1 }}
            noWrap
          >
            @{replyTo.handle || replyTo.username || "无主"}:{" "}
            {replyTo.brief.slice(0, 50)}
            {replyTo.brief.length > 50 ? "…" : ""}
          </Typography>
          <Chip
            label="取消"
            size="small"
            onDelete={onClearReply}
            sx={{ ml: 1 }}
          />
        </Box>
      )}
      {error && (
        <Typography
          variant="caption"
          color="error"
          sx={{ display: "block", mb: 0.5 }}
        >
          {error}
        </Typography>
      )}
      <Box sx={{ display: "flex", alignItems: "flex-end" }}>
        <StickerPicker
          disabled={loading || !online}
          onPick={handleStickerPick}
          subscribeConfigEvents={subscribeConfigEvents}
        />
        {hasFeature(currentUser, "post_images") && (
          <>
            <Tooltip title="发送图片">
              <span>
                <IconButton
                  size="small"
                  onClick={() => imageInputRef.current?.click()}
                  disabled={loading || !online}
                  aria-label="发送图片"
                  sx={{ mb: 0.5, mr: 0.5 }}
                >
                  <ImageIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                handleImagePick(file);
              }}
            />
          </>
        )}
        <TextField
          fullWidth
          multiline
          minRows={1}
          maxRows={5}
          size="small"
          placeholder={composePlaceholder}
          value={content}
          onChange={(e) => handleComposeChange(e.target.value)}
          onKeyDown={handleKeyDown}
          inputProps={{ maxLength: 5000000 }}
          sx={{ mr: 0.5 }}
        />
        <Tooltip title="全屏输入">
          <span>
            <IconButton
              size="small"
              onClick={() => setFullscreenOpen(true)}
              disabled={loading}
              sx={{ mb: 0.5, mr: 0.5 }}
            >
              <OpenInFullIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title="发送">
          <span>
            <IconButton
              color="primary"
              onClick={handlePost}
              disabled={loading || !canSend}
              size="small"
              sx={{ mb: 0.5 }}
            >
              {loading ? <CircularProgress size={20} /> : <SendIcon />}
            </IconButton>
          </span>
        </Tooltip>
      </Box>

      <Dialog
        fullScreen
        open={fullscreenOpen}
        onClose={() => setFullscreenOpen(false)}
      >
        <Box
          sx={{
            display: "flex",
            flexDirection: "column",
            height: "100%",
            bgcolor: "background.paper",
          }}
        >
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              px: 1,
              py: 0.5,
              borderBottom: "1px solid",
              borderColor: "divider",
              flexShrink: 0,
            }}
          >
            <IconButton
              onClick={() => setFullscreenOpen(false)}
              aria-label="退出全屏"
            >
              <CloseFullscreenIcon />
            </IconButton>
            <Typography variant="subtitle2" sx={{ flex: 1, ml: 0.5 }}>
              编辑消息
            </Typography>
            <Tooltip title="发送">
              <span>
                <IconButton
                  color="primary"
                  onClick={() => {
                    setFullscreenOpen(false);
                    void handlePost();
                  }}
                  disabled={loading || !canSend}
                >
                  {loading ? <CircularProgress size={20} /> : <SendIcon />}
                </IconButton>
              </span>
            </Tooltip>
          </Box>
          {error && (
            <Typography
              variant="caption"
              color="error"
              sx={{ display: "block", px: 2, pt: 1 }}
            >
              {error}
            </Typography>
          )}
          <TextField
            autoFocus
            fullWidth
            multiline
            placeholder={composePlaceholder}
            value={content}
            onChange={(e) => handleComposeChange(e.target.value)}
            inputProps={{ maxLength: 5000000 }}
            sx={{
              flex: 1,
              "& .MuiInputBase-root": {
                height: "100%",
                alignItems: "stretch",
              },
              "& .MuiInputBase-inputMultiline": {
                height: "100% !important",
                overflow: "auto !important",
              },
              "& fieldset": { border: "none" },
            }}
          />
        </Box>
      </Dialog>
    </Box>
  );
}
