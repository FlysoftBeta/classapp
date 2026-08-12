import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import CallSplitIcon from "@mui/icons-material/CallSplit";
import CloseIcon from "@mui/icons-material/Close";
import SendIcon from "@mui/icons-material/Send";
import StopCircleOutlinedIcon from "@mui/icons-material/StopCircleOutlined";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import ImageOutlinedIcon from "@mui/icons-material/ImageOutlined";
import Chip from "@mui/material/Chip";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { mermaid } from "@streamdown/mermaid";
import { math } from "@streamdown/math";
import { cjk } from "@streamdown/cjk";
import "streamdown/styles.css";
import "katex/dist/katex.min.css";

import type {
  AiConversationDetail,
  AiCreditBalance,
  AiMessage,
} from "@/shared/types/api";
import type { AiRunUpdatedPayload } from "@/shared/types/events";
import {
  cancelAiRun,
  fetchAiConversation,
  markAiConversationRead,
  startAiRun,
} from "@/client/interact/ai";
import { flexGap, vh } from "@/client/lib/css";

const STREAMDOWN_PLUGINS = { code, mermaid, math, cjk } as const;
type PendingImage = {
  name: string;
  mime: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  data: string;
};

interface AiViewProps {
  conversationId: string | null;
  credits: AiCreditBalance;
  available: boolean;
  unavailableReason: string | null;
  online: boolean;
  subscribeRunEvents: (
    listener: (event: AiRunUpdatedPayload) => void,
  ) => () => void;
  onConversationCreated: (conversationId: string) => void;
  onSidebarRefresh: () => void;
  onBack?: () => void;
}

function mergeMessage(messages: AiMessage[], incoming: AiMessage): AiMessage[] {
  const index = messages.findIndex((message) => message.id === incoming.id);
  const next = [...messages];
  if (index < 0) next.push(incoming);
  else next[index] = incoming;
  return next.sort((left, right) => left.sequence - right.sequence);
}

function messageDepth(messages: AiMessage[], message: AiMessage): number {
  const byId = new Map(messages.map((entry) => [entry.id, entry]));
  const childCounts = new Map<string, number>();
  for (const entry of messages) {
    if (!entry.parent_message_id) continue;
    childCounts.set(
      entry.parent_message_id,
      (childCounts.get(entry.parent_message_id) ?? 0) + 1,
    );
  }
  let current = message.parent_message_id;
  let depth = 0;
  const seen = new Set<string>();
  while (current && depth < 4 && !seen.has(current)) {
    seen.add(current);
    if ((childCounts.get(current) ?? 0) > 1) depth += 1;
    current = byId.get(current)?.parent_message_id ?? null;
  }
  return depth;
}

function statusMessage(
  result: Awaited<ReturnType<typeof startAiRun>>,
): string | null {
  if (result.status === "busy") return "当前对话仍在生成回复";
  if (result.status === "unavailable") return result.error;
  if (result.status === "insufficient_credits") {
    return `Credits 不足：需要预留 ${result.required}，当前可用 ${result.available}`;
  }
  return null;
}

export default function AiView({
  conversationId,
  credits,
  available,
  unavailableReason,
  online,
  subscribeRunEvents,
  onConversationCreated,
  onSidebarRefresh,
  onBack,
}: AiViewProps) {
  const [detail, setDetail] = useState<AiConversationDetail | null>(null);
  const [loading, setLoading] = useState(Boolean(conversationId));
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState("");
  const [forkFrom, setForkFrom] = useState<AiMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [images, setImages] = useState<PendingImage[]>([]);
  const endRef = useRef<HTMLDivElement | null>(null);
  const startedRunIdRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (!conversationId) {
      return;
    }
    try {
      const next = await fetchAiConversation(conversationId);
      setDetail(next);
      if (next.conversation.unread) {
        await markAiConversationRead(conversationId);
        onSidebarRefresh();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载 AI 对话失败");
    } finally {
      setLoading(false);
    }
  }, [conversationId, onSidebarRefresh]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  useEffect(
    () =>
      subscribeRunEvents((event) => {
        if (event.run.conversation_id !== conversationId) {
          if (startedRunIdRef.current === event.run.id) {
            onConversationCreated(event.run.conversation_id);
          }
          return;
        }
        setDetail((current) => {
          if (!current) return current;
          return {
            conversation: event.conversation,
            messages: mergeMessage(current.messages, event.message),
            active_run: ["queued", "routing", "running"].includes(
              event.run.status,
            )
              ? event.run
              : null,
          };
        });
        if (["completed", "failed", "cancelled"].includes(event.run.status)) {
          setSending(false);
          onSidebarRefresh();
          if (event.run.status === "completed") {
            void markAiConversationRead(event.run.conversation_id);
          }
        }
      }),
    [
      conversationId,
      onConversationCreated,
      onSidebarRefresh,
      subscribeRunEvents,
    ],
  );

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [detail?.messages]);

  const running = Boolean(detail?.active_run) || sending;
  const canSend = online && available && !running && draft.trim().length > 0;

  const submit = useCallback(async () => {
    const content = draft.trim();
    if (!content || !online || !available || running) return;
    setSending(true);
    setError(null);
    try {
      const result = await startAiRun({
        ...(conversationId ? { conversationId } : {}),
        content,
        ...(forkFrom ? { forkFromMessageId: forkFrom.id } : {}),
        ...(images.length ? { images } : {}),
      });
      const message = statusMessage(result);
      if (message) {
        setError(message);
        setSending(false);
        return;
      }
      if (result.status !== "started") return;
      startedRunIdRef.current = result.runId;
      setDraft("");
      setForkFrom(null);
      setImages([]);
      onConversationCreated(result.conversationId);
      onSidebarRefresh();
      if (result.conversationId === conversationId) await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "发送失败");
      setSending(false);
    }
  }, [
    available,
    conversationId,
    draft,
    forkFrom,
    load,
    images,
    onConversationCreated,
    onSidebarRefresh,
    online,
    running,
  ]);

  const messages = useMemo(() => detail?.messages ?? [], [detail?.messages]);

  return (
    <Box
      sx={{
        height: vh(1),
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <Box
        sx={{
          minHeight: 58,
          px: 2,
          display: "flex",
          alignItems: "center",
          ...flexGap(1),
          borderBottom: "1px solid",
          borderColor: "divider",
        }}
      >
        {onBack && (
          <IconButton aria-label="返回" onClick={onBack}>
            <ArrowBackIcon />
          </IconButton>
        )}
        <AutoAwesomeIcon color="primary" />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="subtitle1" fontWeight={700} noWrap>
            {detail?.conversation.title ?? "新 AI 对话"}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {credits.balance} credits 可用 · 自动选择模型与思考强度
          </Typography>
        </Box>
        {detail?.active_run && (
          <Button
            size="small"
            color="inherit"
            startIcon={<StopCircleOutlinedIcon />}
            onClick={() => void cancelAiRun(detail.active_run!.id)}
          >
            停止
          </Button>
        )}
      </Box>

      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          px: { xs: 1.5, md: 4 },
          py: 3,
        }}
      >
        <Box sx={{ width: "100%", maxWidth: 880, mx: "auto" }}>
          {loading ? (
            <Box sx={{ display: "flex", justifyContent: "center", py: 8 }}>
              <CircularProgress size={28} />
            </Box>
          ) : messages.length === 0 ? (
            <Box sx={{ textAlign: "center", color: "text.secondary", py: 10 }}>
              <AutoAwesomeIcon
                sx={{ fontSize: 44, mb: 1, color: "primary.main" }}
              />
              <Typography variant="h6">今天想一起完成什么？</Typography>
              <Typography variant="body2">
                可以对话、分析，也可以让 Agent 创建或修改写作文件。
              </Typography>
            </Box>
          ) : (
            messages.map((message) => {
              const isUser = message.role === "user";
              const streaming =
                message.status === "streaming" || message.status === "pending";
              const selectedFork = forkFrom?.id === message.id;
              return (
                <Box
                  key={message.id}
                  sx={{
                    ml: `${Math.min(messageDepth(messages, message), 3) * 12}px`,
                    mb: 2.5,
                    display: "flex",
                    justifyContent: isUser ? "flex-end" : "flex-start",
                  }}
                >
                  <Paper
                    variant={isUser ? "elevation" : "outlined"}
                    elevation={isUser ? 0 : undefined}
                    sx={{
                      position: "relative",
                      maxWidth: isUser ? "82%" : "100%",
                      px: 2,
                      py: 1.5,
                      bgcolor: isUser ? "primary.main" : "background.paper",
                      color: isUser ? "primary.contrastText" : "text.primary",
                      borderColor: selectedFork ? "primary.main" : "divider",
                      borderRadius: 2.5,
                    }}
                  >
                    {isUser ? (
                      <>
                        {message.attachments.length > 0 && (
                          <Box
                            sx={{
                              display: "flex",
                              flexWrap: "wrap",
                              ...flexGap(0.5),
                              mb: 0.75,
                            }}
                          >
                            {message.attachments.map((attachment) => (
                              <Chip
                                key={attachment.path}
                                size="small"
                                icon={<ImageOutlinedIcon />}
                                label={attachment.name}
                                sx={{
                                  bgcolor: "rgba(255,255,255,0.18)",
                                  color: "inherit",
                                }}
                              />
                            ))}
                          </Box>
                        )}
                        <Typography
                          sx={{
                            whiteSpace: "pre-wrap",
                            overflowWrap: "anywhere",
                          }}
                        >
                          {message.content}
                        </Typography>
                      </>
                    ) : (
                      <Box
                        sx={{
                          overflowWrap: "anywhere",
                          "& > :first-of-type": { mt: 0 },
                          "& > :last-child": { mb: 0 },
                        }}
                      >
                        <Streamdown
                          mode={streaming ? "streaming" : "static"}
                          isAnimating={streaming}
                          animated
                          plugins={STREAMDOWN_PLUGINS}
                          controls={{ code: true, mermaid: true }}
                          linkSafety={{ enabled: true }}
                          dir="auto"
                        >
                          {message.content || (streaming ? "正在思考…" : "")}
                        </Streamdown>
                      </Box>
                    )}
                    {!streaming && (
                      <Tooltip title="从此消息创建分支；发送前不会新建对话">
                        <IconButton
                          size="small"
                          aria-label="Fork"
                          onClick={() =>
                            setForkFrom(selectedFork ? null : message)
                          }
                          sx={{ position: "absolute", right: -34, bottom: 0 }}
                        >
                          <CallSplitIcon sx={{ fontSize: 17 }} />
                        </IconButton>
                      </Tooltip>
                    )}
                    {message.status === "failed" && (
                      <Typography variant="caption" color="error">
                        生成失败
                      </Typography>
                    )}
                  </Paper>
                </Box>
              );
            })
          )}
          <div ref={endRef} />
        </Box>
      </Box>

      <Box sx={{ px: { xs: 1.5, md: 4 }, pb: 2, pt: 1 }}>
        <Box sx={{ width: "100%", maxWidth: 880, mx: "auto" }}>
          {forkFrom && (
            <Paper
              variant="outlined"
              sx={{
                mb: 1,
                px: 1.5,
                py: 0.75,
                display: "flex",
                alignItems: "center",
                ...flexGap(1),
              }}
            >
              <CallSplitIcon color="primary" sx={{ fontSize: 18 }} />
              <Typography variant="caption" noWrap sx={{ flex: 1 }}>
                将从「{forkFrom.content.slice(0, 70)}」继续；是否拆成新对话由
                Agent 判断
              </Typography>
              <IconButton size="small" onClick={() => setForkFrom(null)}>
                <CloseIcon fontSize="small" />
              </IconButton>
            </Paper>
          )}
          {error && (
            <Typography
              color="error"
              variant="caption"
              sx={{ display: "block", mb: 0.75 }}
            >
              {error}
            </Typography>
          )}
          {images.length > 0 && (
            <Box
              sx={{
                display: "flex",
                flexWrap: "wrap",
                ...flexGap(0.75),
                mb: 0.75,
              }}
            >
              {images.map((image, index) => (
                <Chip
                  key={`${image.name}-${index}`}
                  size="small"
                  icon={<ImageOutlinedIcon />}
                  label={image.name}
                  onDelete={() =>
                    setImages((current) =>
                      current.filter((_, item) => item !== index),
                    )
                  }
                />
              ))}
            </Box>
          )}
          {!available && (
            <Typography
              color="warning.main"
              variant="caption"
              sx={{ display: "block", mb: 0.75 }}
            >
              {unavailableReason ?? "AI 尚未配置"}
            </Typography>
          )}
          <TextField
            fullWidth
            multiline
            maxRows={8}
            minRows={2}
            value={draft}
            disabled={!online || !available}
            placeholder={
              online
                ? "输入消息；Enter 发送，Shift+Enter 换行"
                : "恢复连接后可用"
            }
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                if (canSend) void submit();
              }
            }}
            slotProps={{
              input: {
                endAdornment: (
                  <IconButton
                    color="primary"
                    disabled={!canSend}
                    onClick={() => void submit()}
                  >
                    {sending ? <CircularProgress size={20} /> : <SendIcon />}
                  </IconButton>
                ),
              },
            }}
            sx={{
              "& .MuiOutlinedInput-root": {
                borderRadius: 3,
                alignItems: "flex-end",
              },
            }}
          />
          <Button
            component="label"
            size="small"
            startIcon={<ImageOutlinedIcon />}
            disabled={!online || !available || running || images.length >= 4}
            sx={{ mt: 0.5 }}
          >
            添加图片（最多 4 张）
            <input
              hidden
              type="file"
              multiple
              accept="image/png,image/jpeg,image/webp,image/gif"
              onChange={(event) => {
                const files = [...(event.target.files ?? [])].slice(
                  0,
                  4 - images.length,
                );
                event.currentTarget.value = "";
                void Promise.all(
                  files.map(async (file): Promise<PendingImage> => {
                    if (file.size > 5 * 1024 * 1024)
                      throw new Error(`${file.name} 超过 5 MB`);
                    const dataUrl = await new Promise<string>(
                      (resolve, reject) => {
                        const reader = new FileReader();
                        reader.onload = () => resolve(String(reader.result));
                        reader.onerror = () => reject(reader.error);
                        reader.readAsDataURL(file);
                      },
                    );
                    const data = dataUrl.slice(dataUrl.indexOf(",") + 1);
                    return {
                      name: file.name,
                      mime: file.type as PendingImage["mime"],
                      data,
                    };
                  }),
                )
                  .then((next) =>
                    setImages((current) => [...current, ...next].slice(0, 4)),
                  )
                  .catch((cause) =>
                    setError(
                      cause instanceof Error ? cause.message : "读取图片失败",
                    ),
                  );
              }}
            />
          </Button>
        </Box>
      </Box>
    </Box>
  );
}
