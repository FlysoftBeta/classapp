import React, { useCallback, useEffect, useState } from "react";
import { alpha } from "@mui/material/styles";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import IconButton from "@mui/material/IconButton";
import CircularProgress from "@mui/material/CircularProgress";
import Tooltip from "@mui/material/Tooltip";
import LinearProgress from "@mui/material/LinearProgress";
import BookmarkIcon from "@mui/icons-material/Bookmark";
import BookmarkBorderIcon from "@mui/icons-material/BookmarkBorder";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import DeleteIcon from "@mui/icons-material/Delete";
import DownloadIcon from "@mui/icons-material/Download";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import Slider from "@mui/material/Slider";
import Button from "@mui/material/Button";
import type { ArticleWithMeta } from "@/shared/types/api";
import { formatBytes } from "@/shared/bytes";
import {
  fetchCachedArticle,
  fetchArticle,
  toggleArticleBookmark,
  deleteArticle,
} from "@/client/api/articles";
import BlobArticleReader from "./BlobArticleReader";
import TextArticleReader from "./TextArticleReader";
import { useArticleReading } from "@/client/hooks/useArticleReading";
import type { UserConfigChangedEvent } from "@/client/hooks/useAppLogic";
import { vh } from "@/client/lib/css";
import { useObservedElementHeight } from "@/client/hooks/useObservedElementHeight";
import {
  ARTICLE_RETENTION_DAYS,
  offlineRepository,
  type ArticleDownloadPolicy,
} from "@/client/resource/offlineRepository";
import { downloadArticleForOffline } from "@/client/resource/offlineSync";

interface ArticleReaderProps {
  articleId: string;
  token: string;
  currentUserId: string;
  isAdmin: boolean;
  onBack: () => void;
  onDeleted?: (id: string) => void;
  themeMode: "light" | "dark";
  subscribeConfigEvents?: (
    fn: (evt: UserConfigChangedEvent) => void,
  ) => () => void;
  online: boolean;
  offlineEnabled: boolean;
}

function formatDate(s: string) {
  const d = new Date(s.endsWith("Z") ? s : s + "Z");
  return d.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  });
}

export default function ArticleReader({
  articleId,
  token,
  currentUserId,
  isAdmin,
  onBack,
  onDeleted,
  themeMode,
  subscribeConfigEvents,
  online,
  offlineEnabled,
}: ArticleReaderProps) {
  const [headerRef, headerHeight] = useObservedElementHeight<HTMLDivElement>();
  const [loadedMeta, setMeta] = useState<ArticleWithMeta | null>(null);
  const [metaLoading, setMetaLoading] = useState(true);
  const [contentLength, setContentLength] = useState(0);
  const [isBookmarked, setIsBookmarked] = useState(false);
  const [bookmarkLoading, setBookmarkLoading] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [downloadOpen, setDownloadOpen] = useState(false);
  const [retentionDays, setRetentionDays] = useState<0 | 1 | 7 | 180>(0);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [offlineContentAvailable, setOfflineContentAvailable] = useState(true);
  const meta = loadedMeta?.id === articleId ? loadedMeta : null;
  const effectiveMetaLoading =
    metaLoading || (loadedMeta !== null && meta === null);

  useEffect(() => {
    void offlineRepository.getArticlePolicy(articleId).then((policy) => {
      setRetentionDays(policy.mode === "retained" ? policy.days : 0);
    });
  }, [articleId]);

  useArticleReading(articleId, online);

  useEffect(() => {
    let cancelled = false;
    const applyArticle = async (article: ArticleWithMeta) => {
      if (cancelled) return;
      setMeta(article);
      setIsBookmarked(article.is_bookmarked);
      setContentLength(article.content_length);
      if (!online && article.content_kind === "text") {
        const segment = await offlineRepository.getArticleSegment(
          articleId,
          article.current_offset ?? 0,
        );
        if (!cancelled) setOfflineContentAvailable(!!segment);
      } else {
        setOfflineContentAvailable(true);
      }
      setMetaLoading(false);
    };
    void (async () => {
      try {
        const cached = await fetchCachedArticle(articleId);
        if (cached?.article) await applyArticle(cached.article);
        if (!online) {
          if (!cached?.article && !cancelled) {
            setOfflineContentAvailable(false);
            setMetaLoading(false);
          }
          return;
        }
        const data = await fetchArticle(articleId);
        if (!data?.article) {
          if (!cancelled) {
            await offlineRepository.removeArticle(articleId);
            setMeta(null);
            setOfflineContentAvailable(false);
            setMetaLoading(false);
            onDeleted?.(articleId);
          }
          return;
        }
        await applyArticle(data.article);
      } finally {
        if (!cancelled) setMetaLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Connectivity changes revalidate in place; the visible reader remains
    // mounted while the remote metadata is being refreshed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [articleId, online]);

  const handleBookmark = async () => {
    setBookmarkLoading(true);
    try {
      const data = await toggleArticleBookmark(articleId, !isBookmarked);
      if (data) {
        setIsBookmarked(!!data.bookmarked);
      }
    } finally {
      setBookmarkLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm("确认删除此文章？此操作不可恢复。")) return;
    setDeleteLoading(true);
    try {
      const { res } = await deleteArticle(articleId);
      if (res.ok) {
        onDeleted?.(articleId);
        onBack();
      }
    } finally {
      setDeleteLoading(false);
    }
  };

  const canDelete = meta && (meta.user_id === currentUserId || isAdmin);

  const handleDownload = async () => {
    const policy: ArticleDownloadPolicy =
      retentionDays === 0
        ? { mode: "auto" }
        : {
            mode: "retained",
            days: retentionDays,
            expiresAt: Date.now() + retentionDays * 86_400_000,
          };
    await offlineRepository.setArticlePolicy(articleId, policy);
    if (meta?.content_kind === "text" && online && retentionDays !== 0) {
      setDownloadProgress(0);
      await downloadArticleForOffline(
        articleId,
        setDownloadProgress,
        meta.content_length,
      );
    }
    const effective = await offlineRepository.getArticlePolicy(articleId);
    setRetentionDays(effective.mode === "retained" ? effective.days : 0);
    setDownloadOpen(false);
  };

  const handleReadingProgress = useCallback((offset: number) => {
    setMeta((current) =>
      current ? { ...current, current_offset: offset } : current,
    );
  }, []);

  return (
    <Box
      data-article-reader
      sx={{
        display: "flex",
        flexDirection: "column",
        minHeight: vh(1),
        position: "relative",
      }}
    >
      <Box
        ref={headerRef}
        sx={(theme) => ({
          position: "sticky",
          top: 0,
          zIndex: 20,
          bgcolor: alpha(theme.palette.background.paper, 0.72),
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
        })}
      >
        <Box
          sx={{
            px: { xs: 1, sm: 2 },
            py: 1,
            borderBottom: "1px solid",
            borderColor: "divider",
            display: "flex",
            alignItems: "center",
            flexShrink: 0,
            gap: 0.5,
          }}
        >
          <IconButton size="small" onClick={onBack} aria-label="返回文章列表">
            <ArrowBackIcon fontSize="small" />
          </IconButton>
          <Box
            sx={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              alignItems: "baseline",
              gap: 1,
            }}
          >
            {meta ? (
              <>
                <Typography
                  variant="subtitle2"
                  fontWeight={700}
                  noWrap
                  sx={{ flex: "1 1 auto", minWidth: 0 }}
                >
                  {meta.title}
                </Typography>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  noWrap
                  sx={{
                    display: { xs: "none", sm: "block" },
                    flex: "0 1 auto",
                    minWidth: 0,
                    maxWidth: "45%",
                  }}
                >
                  {meta.username ? `@${meta.handle ?? meta.username}` : "无主"}{" "}
                  · {formatDate(meta.created_at)}
                </Typography>
              </>
            ) : (
              <Typography variant="subtitle2" color="text.secondary">
                加载中…
              </Typography>
            )}
          </Box>
          {contentLength > 0 && (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{
                display: { xs: "none", sm: "block" },
                flexShrink: 0,
                fontSize: 11,
              }}
            >
              {meta?.content_kind === "blob"
                ? formatBytes(contentLength)
                : `${contentLength.toLocaleString()} 字`}
            </Typography>
          )}
          <Tooltip title={isBookmarked ? "取消收藏" : "收藏"}>
            <span>
              <IconButton
                size="small"
                onClick={handleBookmark}
                disabled={bookmarkLoading || !meta || !online}
                color={isBookmarked ? "primary" : "default"}
              >
                {isBookmarked ? (
                  <BookmarkIcon fontSize="small" />
                ) : (
                  <BookmarkBorderIcon fontSize="small" />
                )}
              </IconButton>
            </span>
          </Tooltip>
          {offlineEnabled && (
            <Tooltip title="离线下载">
              <IconButton
                size="small"
                onClick={() => setDownloadOpen(true)}
                disabled={!meta || meta.content_kind !== "text"}
              >
                <DownloadIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
          {canDelete && (
            <Tooltip title="删除文章">
              <span>
                <IconButton
                  size="small"
                  color="error"
                  onClick={handleDelete}
                  disabled={deleteLoading || !online}
                >
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          )}
        </Box>

        {contentLength > 0 &&
          meta?.current_offset !== undefined &&
          meta.current_offset > 0 && (
            <LinearProgress
              variant="determinate"
              value={Math.min(100, (meta.current_offset / contentLength) * 100)}
              sx={{ height: 2, flexShrink: 0 }}
            />
          )}
      </Box>

      {effectiveMetaLoading ? (
        <Box
          sx={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <CircularProgress size={32} />
        </Box>
      ) : !offlineContentAvailable ? (
        <Box
          sx={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "text.disabled",
          }}
        >
          <Typography variant="body2">
            文章正文未下载，恢复连接后可用
          </Typography>
        </Box>
      ) : meta?.content_kind === "blob" ? (
        <BlobArticleReader
          key={articleId}
          articleId={articleId}
          token={token}
          title={meta.title}
          initialPage={meta.current_offset ?? 0}
          themeMode={themeMode}
          subscribeConfigEvents={subscribeConfigEvents}
        />
      ) : meta ? (
        <TextArticleReader
          key={articleId}
          articleId={articleId}
          contentLength={meta.content_length}
          initialOffset={meta.current_offset ?? 0}
          paddingStart={headerHeight}
          online={online}
          onProgressChange={handleReadingProgress}
        />
      ) : null}
      <Dialog
        open={downloadOpen}
        onClose={() => setDownloadOpen(false)}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>文章离线策略</DialogTitle>
        <DialogContent>
          <Box sx={{ px: 1.5, mt: 2 }}>
            <Typography variant="body2" gutterBottom>
              从现在开始倒计时保留
            </Typography>
            <Slider
              value={[0, ...ARTICLE_RETENTION_DAYS].indexOf(retentionDays)}
              min={0}
              max={3}
              step={1}
              marks={[
                { value: 0, label: "自动" },
                { value: 1, label: "1 天" },
                { value: 2, label: "1 周" },
                { value: 3, label: "半年" },
              ]}
              onChange={(_, value) =>
                setRetentionDays(
                  ([0, ...ARTICLE_RETENTION_DAYS] as const)[value as number],
                )
              }
            />
          </Box>
          {downloadProgress > 0 && (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: "block", mt: 1 }}
            >
              下载 {downloadProgress}%
            </Typography>
          )}
          {!online && retentionDays !== 0 && (
            <Typography
              variant="caption"
              color="warning.main"
              sx={{ display: "block", mt: 1 }}
            >
              当前离线，只保存策略；已有内容仍可阅读。
            </Typography>
          )}
          <Box
            sx={{ display: "flex", justifyContent: "flex-end", gap: 1, mt: 2 }}
          >
            <Button onClick={() => setDownloadOpen(false)}>取消</Button>
            <Button variant="contained" onClick={handleDownload}>
              保存并下载
            </Button>
          </Box>
        </DialogContent>
      </Dialog>
    </Box>
  );
}
