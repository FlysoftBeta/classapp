import React from "react";
import Typography from "@mui/material/Typography";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import ButtonBase from "@mui/material/ButtonBase";
import ArticleIcon from "@mui/icons-material/Article";
import BookmarkIcon from "@mui/icons-material/BookmarkBorder";
import type { ArticleWithMeta } from "@/shared/types/api";
import { SidebarSection } from "./SidebarSection";

interface ArticleSectionProps {
  articles: ArticleWithMeta[];
  currentArticleId?: string | null;
  onOpenArticle: (id: string) => void;
  onOpenArticles: () => void;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}

export function ArticleSection({
  articles,
  currentArticleId,
  onOpenArticle,
  onOpenArticles,
  expanded,
  onExpandedChange,
}: ArticleSectionProps) {
  return (
    <SidebarSection
      title="文章"
      scrollable
      flexWeight={1}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
      action={
        <ButtonBase
          onClick={onOpenArticles}
          sx={{
            px: 0.75,
            py: 0.25,
            borderRadius: 1,
            "&:hover": { bgcolor: "action.hover" },
          }}
        >
          <Typography
            variant="caption"
            color="text.disabled"
            sx={{ fontSize: 10 }}
          >
            查看全部 ›
          </Typography>
        </ButtonBase>
      }
    >
      {articles.length > 0 ? (
        <List disablePadding dense sx={{ pb: 0.5 }}>
          {articles.map((a) => {
            const selected = currentArticleId === a.id;
            return (
              <ListItemButton
                key={a.id}
                selected={selected}
                onClick={() => onOpenArticle(a.id)}
                sx={{ px: 1.5, py: 0.5, borderRadius: 1, mx: 0.5 }}
              >
                {a.is_bookmarked ? (
                  <BookmarkIcon
                    sx={{
                      mr: 1,
                      fontSize: 12,
                      color: "primary.main",
                      flexShrink: 0,
                    }}
                  />
                ) : (
                  <ArticleIcon
                    sx={{
                      mr: 1,
                      fontSize: 12,
                      color: "text.secondary",
                      flexShrink: 0,
                    }}
                  />
                )}
                <ListItemText
                  primary={a.title}
                  primaryTypographyProps={{
                    variant: "caption",
                    noWrap: true,
                    color: selected ? "text.primary" : "text.secondary",
                    fontWeight: selected ? 700 : 400,
                  }}
                />
              </ListItemButton>
            );
          })}
        </List>
      ) : (
        <Typography
          variant="caption"
          color="text.disabled"
          sx={{ display: "block", px: 1.5, pb: 1 }}
        >
          暂无阅读记录
        </Typography>
      )}
    </SidebarSection>
  );
}
