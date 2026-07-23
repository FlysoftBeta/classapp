import React, { useCallback, useLayoutEffect, useRef, useState } from "react";
import { alpha } from "@mui/material/styles";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import IconButton from "@mui/material/IconButton";
import Divider from "@mui/material/Divider";
import Chip from "@mui/material/Chip";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ArticleIcon from "@mui/icons-material/Article";
import BookmarkIcon from "@mui/icons-material/Bookmark";
import type { ArticleWithMeta } from "@/shared/types/api";
import { formatBytes } from "@/shared/bytes";
import { vh } from "@/client/lib/css";
import { ArticleImportFab } from "./ArticleImportFab";
import Infini2View from "@/client/components/shared/Infini2View";
import { useInfini2, type Infini2Provider } from "@/lib/infini2";
import { listArticles } from "@/client/api/articles";
import { useObservedElementHeight } from "@/client/hooks/useObservedElementHeight";
import { InfiniId } from "@/client/components/debug/InfiniId";
import { useDebugStore } from "@/client/store/debugStore";

const RECENT_ARTICLES_ID = "article-list:recent";

interface RecentArticlesRow {
  kind: "recent";
  id: typeof RECENT_ARTICLES_ID;
  articles: ArticleWithMeta[];
}

interface ArticleEntryRow {
  kind: "article";
  article: ArticleWithMeta;
  offset: number;
}

type ArticleRow = RecentArticlesRow | ArticleEntryRow;

const ARTICLE_PAGE_SIZE = 50;
const ARTICLE_ROW_HEIGHT = 58;
interface ArticleCursor {
  offset: number;
}

const ARTICLE_OPS = {
  getId: (row: ArticleRow) => (row.kind === "recent" ? row.id : row.article.id),
  getCursor: (row: ArticleRow): ArticleCursor => ({
    offset: row.kind === "recent" ? 0 : row.offset,
  }),
};

function estimateArticleRowSize(row: ArticleRow): number {
  if (row.kind === "article") return ARTICLE_ROW_HEIGHT;
  return 28 + (row.articles.length > 0 ? 45 + row.articles.length * 58 : 0);
}

interface ArticleListProps {
  sidebarArticles?: ArticleWithMeta[];
  currentArticleId?: string | null;
  onOpenArticle: (id: string) => void;
  refreshKey: number;
  onBack?: () => void;
  token: string;
  downloadEnabled: boolean;
}

function formatDate(s: string) {
  const d = new Date(s.endsWith("Z") ? s : s + "Z");
  return d.toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" });
}

function formatArticleSize(a: ArticleWithMeta) {
  if (a.content_kind === "blob") {
    return formatBytes(a.file_size || a.content_length || 0);
  }
  return `${(a.content_length ?? 0).toLocaleString()}字`;
}

function formatReadTime(seconds: number) {
  if (seconds < 60) return `${seconds}秒`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}分钟`;
  return `${Math.floor(mins / 60)}小时${mins % 60}分`;
}

const ArticleVirtualRow = React.memo(function ArticleVirtualRow({
  article,
  selected,
  onOpenArticle,
}: {
  article: ArticleWithMeta;
  selected: boolean;
  onOpenArticle: (id: string) => void;
}) {
  return (
    <Box data-infini-id={article.id} sx={{ width: "100%" }}>
      <InfiniId id={article.id} />
      <ListItemButton
        selected={selected}
        onClick={() => onOpenArticle(article.id)}
        sx={{
          width: "calc(100% - 8px)",
          px: 1.5,
          py: 0.75,
          borderRadius: 1,
          mx: 0.5,
        }}
      >
        <ArticleIcon
          sx={{
            mr: 1,
            fontSize: 14,
            color: selected ? "primary.main" : "text.secondary",
            flexShrink: 0,
          }}
        />
        <ListItemText
          primary={article.title}
          secondary={`${formatDate(article.created_at)} · ${formatArticleSize(article)}`}
          primaryTypographyProps={{
            variant: "body2",
            noWrap: true,
            fontWeight: selected ? 700 : 400,
          }}
          secondaryTypographyProps={{
            variant: "caption",
            noWrap: true,
          }}
        />
        {article.is_bookmarked && (
          <BookmarkIcon
            sx={{
              fontSize: 12,
              ml: 0.5,
              color: "primary.main",
              flexShrink: 0,
            }}
          />
        )}
      </ListItemButton>
    </Box>
  );
});

const RecentArticlesVirtualRow = React.memo(function RecentArticlesVirtualRow({
  articles,
  currentArticleId,
  showEmpty,
  onOpenArticle,
}: {
  articles: ArticleWithMeta[];
  currentArticleId: string | null;
  showEmpty: boolean;
  onOpenArticle: (id: string) => void;
}) {
  return (
    <Box
      data-infini-id={RECENT_ARTICLES_ID}
      sx={{ width: "100%", overflowX: "hidden" }}
    >
      {articles.length > 0 && (
        <>
          <Typography
            variant="caption"
            sx={{
              px: 1.5,
              pt: 1.5,
              pb: 0.5,
              display: "flex",
              alignItems: "center",
              gap: 0.5,
              color: "text.disabled",
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: 0.5,
              fontSize: 10,
            }}
          >
            <ArticleIcon sx={{ fontSize: 11 }} />
            最近阅读
          </Typography>
          <List disablePadding dense>
            {articles.map((article) => {
              const selected = currentArticleId === article.id;
              return (
                <ListItemButton
                  key={`recent-${article.id}`}
                  selected={selected}
                  onClick={() => onOpenArticle(article.id)}
                  sx={{
                    width: "calc(100% - 8px)",
                    px: 1.5,
                    py: 0.75,
                    borderRadius: 1,
                    mx: 0.5,
                  }}
                >
                  {article.is_bookmarked ? (
                    <BookmarkIcon
                      sx={{
                        mr: 1,
                        fontSize: 14,
                        color: "primary.main",
                        flexShrink: 0,
                      }}
                    />
                  ) : (
                    <ArticleIcon
                      sx={{
                        mr: 1,
                        fontSize: 14,
                        color: selected ? "primary.main" : "text.secondary",
                        flexShrink: 0,
                      }}
                    />
                  )}
                  <ListItemText
                    primary={article.title}
                    secondary={`${formatArticleSize(article)}${
                      (article.total_read_seconds ?? 0) > 0
                        ? ` · 已读 ${formatReadTime(article.total_read_seconds ?? 0)}`
                        : ""
                    }`}
                    primaryTypographyProps={{
                      variant: "body2",
                      noWrap: true,
                      fontWeight: selected ? 700 : 500,
                    }}
                    secondaryTypographyProps={{
                      variant: "caption",
                      noWrap: true,
                    }}
                  />
                  {article.current_offset > 0 && article.content_length > 0 && (
                    <Chip
                      label={`${Math.round(
                        (article.current_offset / article.content_length) * 100,
                      )}%`}
                      size="small"
                      variant="outlined"
                      sx={{ ml: 0.5, flexShrink: 0, fontSize: 10 }}
                    />
                  )}
                </ListItemButton>
              );
            })}
          </List>
          <Divider sx={{ my: 1 }} />
        </>
      )}

      <Typography
        variant="caption"
        sx={{
          px: 1.5,
          pt: articles.length > 0 ? 0 : 1.5,
          pb: 0.5,
          display: "block",
          color: "text.disabled",
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          fontSize: 10,
        }}
      >
        全部文章
      </Typography>

      {showEmpty && (
        <Box sx={{ p: 2, textAlign: "center" }}>
          <Typography variant="caption" color="text.disabled">
            还没有文章
          </Typography>
        </Box>
      )}
    </Box>
  );
});

function ignoreArticleCreated(): void {
  // article.list_updated owns invalidation, matching the other Infini consumers.
}

export default function ArticleList({
  refreshKey,
  ...props
}: ArticleListProps) {
  return (
    <ArticleListSession key={refreshKey} refreshKey={refreshKey} {...props} />
  );
}

function ArticleListSession({
  sidebarArticles = [],
  currentArticleId = null,
  onOpenArticle,
  onBack,
  token,
  downloadEnabled,
}: ArticleListProps) {
  const showInfiniLogs = useDebugStore((state) => state.showInfiniLogs);
  const [total, setTotal] = useState(0);
  const totalRef = useRef(0);
  const sidebarArticlesRef = useRef(sidebarArticles);
  const [headerRef, headerHeight] = useObservedElementHeight<HTMLDivElement>();

  useLayoutEffect(() => {
    sidebarArticlesRef.current = sidebarArticles;
  }, [sidebarArticles]);

  const loadRows = useCallback(
    async (start: number, wanted: number, signal: AbortSignal) => {
      const rows: ArticleEntryRow[] = [];
      let offset = Math.max(0, start);
      let knownTotal = totalRef.current;
      while (rows.length < wanted) {
        const data = await listArticles(offset);
        if (signal.aborted) throw new Error("article list request superseded");
        if (!data) throw new Error("article list request failed");
        knownTotal = data.total ?? 0;
        totalRef.current = knownTotal;
        setTotal(knownTotal);
        const articles = data.articles ?? [];
        rows.push(
          ...articles.map<ArticleEntryRow>((article, index) => ({
            kind: "article",
            article,
            offset: offset + index,
          })),
        );
        offset += articles.length;
        if (
          articles.length < ARTICLE_PAGE_SIZE ||
          offset >= knownTotal ||
          articles.length === 0
        ) {
          break;
        }
      }
      return { rows, total: knownTotal };
    },
    [],
  );

  const provider: Infini2Provider<ArticleRow, ArticleCursor, string> = {
    async bootstrap({ cursor, targetSize, signal }) {
      const wanted = Math.max(
        ARTICLE_PAGE_SIZE,
        Math.ceil(targetSize / ARTICLE_ROW_HEIGHT) + 4,
      );
      const target = Math.max(0, cursor?.offset ?? 0);
      const start = target === 0 ? 0 : Math.max(0, target - wanted / 2);
      const normalizedStart = Math.floor(start);
      const loaded = await loadRows(normalizedStart, wanted, signal);
      const items: ArticleRow[] =
        normalizedStart === 0
          ? [
              {
                kind: "recent",
                id: RECENT_ARTICLES_ID,
                articles: sidebarArticlesRef.current,
              },
              ...loaded.rows,
            ]
          : loaded.rows;
      return {
        items,
        exhaustedBefore: normalizedStart === 0,
        exhaustedAfter: normalizedStart + loaded.rows.length >= loaded.total,
      };
    },
    async fetch({ cursor, direction, targetSize, signal }) {
      const wanted = Math.max(
        ARTICLE_PAGE_SIZE,
        Math.ceil(targetSize / ARTICLE_ROW_HEIGHT) + 4,
      );
      if (direction === "before") {
        const end = Math.max(0, cursor.offset);
        if (end === 0) {
          return {
            items: [],
            exhaustedBefore: true,
            exhaustedAfter: false,
          };
        }
        const start = Math.max(0, end - wanted);
        const loaded = await loadRows(start, end - start, signal);
        const rows = loaded.rows.filter((row) => row.offset < end);
        const items: ArticleRow[] =
          start === 0
            ? [
                {
                  kind: "recent",
                  id: RECENT_ARTICLES_ID,
                  articles: sidebarArticlesRef.current,
                },
                ...rows,
              ]
            : rows;
        return {
          items,
          exhaustedBefore: start === 0,
          exhaustedAfter: false,
        };
      }
      const start = cursor.offset + 1;
      const loaded = await loadRows(start, wanted, signal);
      return {
        items: loaded.rows,
        exhaustedBefore: false,
        exhaustedAfter: start + loaded.rows.length >= loaded.total,
      };
    },
    async locateOffset({ anchor, signedItemOffset, signal }) {
      const anchorOffset = anchor.kind === "recent" ? 0 : anchor.offset;
      const upper = Math.max(0, totalRef.current - 1);
      const target = Math.max(
        0,
        Math.min(upper, anchorOffset + signedItemOffset),
      );
      const data = await listArticles(target);
      if (signal.aborted)
        throw new Error("article list locate request superseded");
      if (!data) throw new Error("article list locate request failed");
      totalRef.current = data.total ?? 0;
      setTotal(totalRef.current);
      return {
        cursor: { offset: target },
        targetId: data.articles[0]?.id ?? RECENT_ARTICLES_ID,
      };
    },
  };

  const { controller, snapshot } = useInfini2<
    ArticleRow,
    ArticleCursor,
    string
  >({
    debug: showInfiniLogs ? "ArticleList" : undefined,
    provider,
    ops: ARTICLE_OPS,
    estimateSize: estimateArticleRowSize,
    initial: { cursor: { offset: 0 }, alignment: "start" },
    residentBefore: 8,
    residentAfter: 8,
    defaultItemEstimate: ARTICLE_ROW_HEIGHT,
  });

  useLayoutEffect(() => {
    controller.updateExternal([
      {
        kind: "recent",
        id: RECENT_ARTICLES_ID,
        articles: sidebarArticles,
      },
    ]);
  }, [controller, sidebarArticles]);

  const renderRow = useCallback(
    (row: ArticleRow) => {
      if (row.kind === "recent") {
        return (
          <RecentArticlesVirtualRow
            articles={row.articles}
            currentArticleId={currentArticleId}
            showEmpty={snapshot.phase.status === "ready" && total === 0}
            onOpenArticle={onOpenArticle}
          />
        );
      }
      return (
        <ArticleVirtualRow
          article={row.article}
          selected={currentArticleId === row.article.id}
          onOpenArticle={onOpenArticle}
        />
      );
    },
    [currentArticleId, onOpenArticle, snapshot.phase.status, total],
  );

  return (
    <Box
      sx={{
        minHeight: vh(1),
        bgcolor: "background.paper",
        position: "relative",
        overflowAnchor: "none",
      }}
    >
      <Box
        ref={headerRef}
        sx={(theme) => ({
          px: 1.5,
          py: 1,
          display: "flex",
          alignItems: "center",
          borderBottom: "1px solid",
          borderColor: "divider",
          position: "sticky",
          top: 0,
          zIndex: 20,
          bgcolor: alpha(theme.palette.background.paper, 0.72),
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
        })}
      >
        {onBack && (
          <IconButton size="small" onClick={onBack} sx={{ mr: 0.5 }}>
            <ArrowBackIcon fontSize="small" />
          </IconButton>
        )}
        <Typography variant="subtitle2" sx={{ flex: 1, fontWeight: 700 }}>
          文章
        </Typography>
        {total > 0 && <Chip label={total} size="small" variant="outlined" />}
      </Box>

      <Infini2View
        controller={controller}
        snapshot={snapshot}
        renderItem={renderRow}
        beforeLabel="加载较新的文章"
        afterLabel="加载更多文章"
        onRetry={controller.retry.bind(controller)}
        paddingStart={headerHeight}
        layoutBefore={1800}
        layoutAfter={1800}
        anchorRatio={0}
        rootSx={{
          position: "relative",
          minHeight: snapshot.mainLength ? 0 : 96,
        }}
        footer={
          total > 0 && snapshot.exhaustedAfter ? (
            <Typography
              variant="caption"
              color="text.disabled"
              sx={{ display: "block", py: 1, textAlign: "center" }}
            >
              已到末尾 · 共 {total} 篇
            </Typography>
          ) : null
        }
      />
      <ArticleImportFab
        token={token}
        downloadEnabled={downloadEnabled}
        onCreated={ignoreArticleCreated}
      />
    </Box>
  );
}
