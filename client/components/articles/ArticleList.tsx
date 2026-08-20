import React, { useEffect, useState } from "react";
import { alpha } from "@mui/material/styles";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import IconButton from "@mui/material/IconButton";
import Button from "@mui/material/Button";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ArticleIcon from "@mui/icons-material/Article";
import BookmarkIcon from "@mui/icons-material/Bookmark";
import MenuBookIcon from "@mui/icons-material/MenuBook";
import AddIcon from "@mui/icons-material/Add";
import type { Article, Conversation } from "@/client/interact/presentation";
import type { BooklistSnapshot, BooklistSummary } from "@/shared/types/api";
import { formatBytes } from "@/shared/bytes";
import { flexGap, vh } from "@/client/lib/css";
import { ArticleImportFab } from "./ArticleImportFab";
import { AccessibleListRow } from "@/client/components/library/AccessibleListRow";
import { LibrarySection } from "@/client/components/library/LibrarySection";
import {
  createBooklist,
  fetchArticlesLibrary,
  fetchGroupBooklist,
} from "@/client/interact/articles";
import TextField from "@mui/material/TextField";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";

interface ArticleListProps {
  sidebarArticles?: Article[];
  currentArticleId?: string | null;
  onOpenArticle: (id: string) => void;
  onOpenBooklist: (booklistId: string) => void;
  refreshKey: number;
  onBack?: () => void;
  token: string;
  downloadEnabled: boolean;
  conversation?: Conversation;
}

function formatDate(s: string) {
  const d = new Date(s.endsWith("Z") ? s : s + "Z");
  return d.toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" });
}

function formatArticleSize(a: Article) {
  if (a.content_kind === "bundle") {
    return formatBytes(a.file_size || a.content_length || 0);
  }
  return `${(a.content_length ?? 0).toLocaleString()}字`;
}

function ArticleRow({
  article,
  selected,
  onOpenArticle,
}: {
  article: Article;
  selected: boolean;
  onOpenArticle: (id: string) => void;
}) {
  return (
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
      {article.is_bookmarked ? (
        <BookmarkIcon
          sx={{ mr: 1, fontSize: 14, color: "primary.main", flexShrink: 0 }}
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
        secondary={`${formatDate(article.created_at)} · ${formatArticleSize(article)}`}
        primaryTypographyProps={{
          variant: "body2",
          noWrap: true,
          fontWeight: selected ? 700 : 400,
        }}
        secondaryTypographyProps={{ variant: "caption", noWrap: true }}
      />
    </ListItemButton>
  );
}

function ignoreArticleCreated(): void {}

export default function ArticleList({
  refreshKey,
  conversation,
  ...props
}: ArticleListProps) {
  return (
    <ArticleLibrary
      key={`${refreshKey}:${conversation?.type ?? "all"}:${conversation?.id ?? "all"}`}
      refreshKey={refreshKey}
      conversation={conversation}
      {...props}
    />
  );
}

function ArticleLibrary({
  sidebarArticles = [],
  currentArticleId = null,
  onOpenArticle,
  onOpenBooklist,
  onBack,
  token,
  downloadEnabled,
  conversation,
}: ArticleListProps) {
  const groupId = conversation?.type === "group" ? conversation.id : undefined;
  const [recents, setRecents] = useState<Article[]>(sidebarArticles);
  const [favorites, setFavorites] = useState<Article[]>([]);
  const [booklists, setBooklists] = useState<BooklistSummary[]>([]);
  const [groupSnapshot, setGroupSnapshot] = useState<BooklistSnapshot | null>(
    null,
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState("");

  useEffect(() => {
    let cancelled = false;
    if (groupId) {
      void fetchGroupBooklist(groupId).then((snapshot) => {
        if (!cancelled) setGroupSnapshot(snapshot);
      });
      return () => {
        cancelled = true;
      };
    }
    void fetchArticlesLibrary().then((library) => {
      if (cancelled || !library) return;
      setRecents(library.recents);
      setFavorites(library.favorites);
      setBooklists(library.booklists);
    });
    return () => {
      cancelled = true;
    };
  }, [groupId]);

  const groupArticles = groupSnapshot?.articles ?? [];

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
          {conversation?.type === "group"
            ? `# ${conversation.name} 的文单`
            : "文章"}
        </Typography>
        {!groupId && (
          <Button
            size="small"
            startIcon={<AddIcon />}
            onClick={() => setCreateOpen(true)}
          >
            新建文单
          </Button>
        )}
      </Box>

      <Box sx={{ overflowY: "auto", pb: 10 }}>
        {groupId ? (
          <LibrarySection title="文单内容" empty="这本文单还是空的">
            {groupArticles.map((article) => (
              <ArticleRow
                key={article.id}
                article={article}
                selected={currentArticleId === article.id}
                onOpenArticle={onOpenArticle}
              />
            ))}
          </LibrarySection>
        ) : (
          <>
            <LibrarySection title="最近阅读" empty="还没有阅读记录">
              {recents.map((article) => (
                <ArticleRow
                  key={`recent-${article.id}`}
                  article={article}
                  selected={currentArticleId === article.id}
                  onOpenArticle={onOpenArticle}
                />
              ))}
            </LibrarySection>
            <LibrarySection title="收藏" empty="还没有收藏文章">
              {favorites.map((article) => (
                <ArticleRow
                  key={`fav-${article.id}`}
                  article={article}
                  selected={currentArticleId === article.id}
                  onOpenArticle={onOpenArticle}
                />
              ))}
            </LibrarySection>
            <LibrarySection title="文单" empty="还没有可访问的文单">
              {booklists.map((list) => (
                <AccessibleListRow
                  key={list.id}
                  title={list.title}
                  subtitle={`${list.item_count} 篇`}
                  icon={<MenuBookIcon fontSize="small" color="disabled" />}
                  onOpen={() => onOpenBooklist(list.id)}
                />
              ))}
            </LibrarySection>
          </>
        )}
      </Box>

      {conversation?.type === "group" && (
        <ArticleImportFab
          token={token}
          conversation={conversation}
          downloadEnabled={downloadEnabled}
          onCreated={ignoreArticleCreated}
        />
      )}
      {createOpen && (
        <Dialog open onClose={() => setCreateOpen(false)} fullWidth maxWidth="xs">
          <DialogTitle>新建文单</DialogTitle>
          <DialogContent>
            <TextField
              autoFocus
              fullWidth
              margin="dense"
              label="文单名称"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setCreateOpen(false)}>取消</Button>
            <Button
              variant="contained"
              disabled={!title.trim()}
              onClick={() => {
                void createBooklist(title.trim()).then((snapshot) => {
                  setCreateOpen(false);
                  setTitle("");
                  if (snapshot) onOpenBooklist(snapshot.list.id);
                });
              }}
            >
              创建
            </Button>
          </DialogActions>
        </Dialog>
      )}
    </Box>
  );
}
