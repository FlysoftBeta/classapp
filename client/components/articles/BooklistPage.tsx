import React, { useEffect, useState } from "react";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import IconButton from "@mui/material/IconButton";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import Typography from "@mui/material/Typography";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import DeleteIcon from "@mui/icons-material/Delete";
import MenuBookIcon from "@mui/icons-material/MenuBook";
import ShareIcon from "@mui/icons-material/Share";
import RemoveCircleOutlineIcon from "@mui/icons-material/RemoveCircleOutline";
import type { BooklistSnapshot } from "@/shared/types/api";
import type { AccessBindingView } from "@/shared/access";
import { flexGap } from "@/client/lib/css";
import { ShareAccessDialog } from "@/client/components/library/ShareAccessDialog";
import {
  deleteBooklist,
  fetchBooklist,
  grantBooklistAccess,
  listBooklistBindings,
  removeArticleFromBooklist,
  revokeBooklistAccess,
} from "@/client/interact/articles";

export function BooklistPage({
  booklistId,
  onBack,
  onOpenArticle,
}: {
  booklistId: string;
  onBack: () => void;
  onOpenArticle: (id: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<BooklistSnapshot | null>(null);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [bindings, setBindings] = useState<AccessBindingView[]>([]);
  const loading = loadedId !== booklistId;
  const access = snapshot?.list.access;
  const canWrite = access?.write === true;
  const canOwn = access?.own === true;
  const canShare = access?.shareRead === true;

  useEffect(() => {
    let cancelled = false;
    void fetchBooklist(booklistId).then((value) => {
      if (cancelled) return;
      setSnapshot(value);
      setLoadedId(booklistId);
    });
    return () => {
      cancelled = true;
    };
  }, [booklistId]);

  return (
    <Box
      sx={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          ...flexGap(1),
          px: 1.5,
          py: 1,
          borderBottom: "1px solid",
          borderColor: "divider",
          flexShrink: 0,
        }}
      >
        <IconButton
          size="small"
          title="返回"
          aria-label="返回文章库"
          onClick={onBack}
        >
          <ArrowBackIcon fontSize="small" />
        </IconButton>
        <Box
          sx={{
            width: 44,
            height: 44,
            borderRadius: 1.5,
            bgcolor: "action.hover",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <MenuBookIcon fontSize="small" color="disabled" />
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="subtitle1" fontWeight={700} noWrap>
            {snapshot?.list.title ?? "文单"}
          </Typography>
          <Typography variant="caption" color="text.disabled">
            {snapshot ? `${snapshot.items.length} 篇` : "正在加载…"}
          </Typography>
        </Box>
        {snapshot && (
          <>
            {canShare && (
              <IconButton
                size="small"
                title="分享"
                aria-label="分享文单"
                onClick={() => {
                  void listBooklistBindings(booklistId).then((result) => {
                    setBindings(result.bindings);
                    setShareOpen(true);
                  });
                }}
              >
                <ShareIcon fontSize="small" />
              </IconButton>
            )}
            {canOwn && (
              <IconButton
                size="small"
                title="删除文单"
                aria-label="删除文单"
                onClick={() => {
                  void deleteBooklist(booklistId).then((ok) => {
                    if (ok) onBack();
                  });
                }}
              >
                <DeleteIcon fontSize="small" />
              </IconButton>
            )}
          </>
        )}
      </Box>

      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", p: 1, pb: 10 }}>
        {loading && !snapshot ? (
          <Box
            sx={{
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <CircularProgress size={28} />
          </Box>
        ) : !snapshot ? (
          <Typography
            variant="body2"
            color="text.disabled"
            sx={{ p: 2, textAlign: "center" }}
          >
            无法加载文单
          </Typography>
        ) : snapshot.articles.length === 0 ? (
          <Typography
            variant="body2"
            color="text.disabled"
            sx={{ p: 2, textAlign: "center" }}
          >
            文单里还没有文章
          </Typography>
        ) : (
          snapshot.articles.map((article) => (
            <ListItemButton
              key={article.id}
              onClick={() => onOpenArticle(article.id)}
              sx={{ borderRadius: 1 }}
            >
              <ListItemText
                primary={article.title}
                primaryTypographyProps={{ variant: "body2", noWrap: true }}
              />
              {canWrite && (
                <IconButton
                  size="small"
                  title="从文单移除"
                  onClick={(event) => {
                    event.stopPropagation();
                    void removeArticleFromBooklist(booklistId, article.id).then(
                      (next) => {
                        if (next) setSnapshot(next);
                      },
                    );
                  }}
                >
                  <RemoveCircleOutlineIcon fontSize="small" />
                </IconButton>
              )}
            </ListItemButton>
          ))
        )}
      </Box>

      {shareOpen && snapshot && (
        <ShareAccessDialog
          title="分享文单"
          flags={snapshot.list.access}
          bindings={bindings}
          onGrant={async (principal, grant) => {
            const next = await grantBooklistAccess(
              booklistId,
              principal,
              grant,
            );
            if (next) setSnapshot(next);
            const result = await listBooklistBindings(booklistId);
            setBindings(result.bindings);
          }}
          onRevoke={async (principal) => {
            const next = await revokeBooklistAccess(booklistId, principal);
            if (next) setSnapshot(next);
            const result = await listBooklistBindings(booklistId);
            setBindings(result.bindings);
          }}
          onClose={() => setShareOpen(false)}
        />
      )}
    </Box>
  );
}
