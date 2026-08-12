import React, { useEffect, useState } from "react";
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import IconButton from "@mui/material/IconButton";
import InputAdornment from "@mui/material/InputAdornment";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import AddIcon from "@mui/icons-material/Add";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import SearchIcon from "@mui/icons-material/Search";
import type { AiConversation, AiCreditBalance } from "@/shared/types/api";
import { searchAiConversations } from "@/client/interact/ai";

interface AiSectionProps {
  conversations: AiConversation[];
  credits: AiCreditBalance;
  available: boolean;
  unavailableReason: string | null;
  selectedId: string | null;
  online: boolean;
  onOpen: (id: string) => void;
  onNew: () => void;
}

export function AiSection({
  conversations,
  credits,
  available,
  unavailableReason,
  selectedId,
  online,
  onOpen,
  onNew,
}: AiSectionProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AiConversation[] | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const normalized = query.trim();
    if (!normalized) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setSearching(true);
      void searchAiConversations(normalized)
        .then((value) => {
          if (!cancelled) setResults(value);
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const entries = query.trim() ? (results ?? []) : conversations;

  return (
    <Box
      sx={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}
    >
      <Box
        sx={{
          px: 1.5,
          py: 1,
          borderBottom: "1px solid",
          borderColor: "divider",
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", mb: 1 }}>
          <Typography variant="subtitle2" fontWeight={700} sx={{ flex: 1 }}>
            AI
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ mr: 0.5 }}>
            {credits.balance} credits
          </Typography>
          <Tooltip title="新对话">
            <span>
              <IconButton
                size="small"
                disabled={!online || !available}
                onClick={onNew}
              >
                <AddIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Box>
        <TextField
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setResults(null);
            setSearching(false);
          }}
          placeholder="搜索标题和标签"
          size="small"
          fullWidth
          disabled={!online || !available}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ fontSize: 18 }} />
                </InputAdornment>
              ),
              endAdornment: searching ? (
                <InputAdornment position="end">
                  <CircularProgress size={14} />
                </InputAdornment>
              ) : undefined,
            },
          }}
        />
      </Box>
      {!available ? (
        <Typography variant="caption" color="text.disabled" sx={{ p: 2 }}>
          {unavailableReason ?? "AI 尚未配置"}
        </Typography>
      ) : entries.length ? (
        <List
          dense
          disablePadding
          sx={{ overflowY: "auto", minHeight: 0, py: 0.5 }}
        >
          {entries.map((conversation) => (
            <ListItemButton
              key={conversation.id}
              selected={selectedId === conversation.id}
              onClick={() => onOpen(conversation.id)}
              sx={{ px: 1.5, py: 0.75, borderRadius: 1, mx: 0.5 }}
            >
              <AutoAwesomeIcon
                sx={{
                  mr: 1,
                  fontSize: 16,
                  color: "text.secondary",
                  flexShrink: 0,
                }}
              />
              <ListItemText
                sx={{ minWidth: 0 }}
                primary={conversation.title}
                secondary={
                  conversation.last_message ||
                  (conversation.running ? "正在回复…" : null)
                }
                primaryTypographyProps={{
                  variant: "body2",
                  noWrap: true,
                  fontWeight:
                    selectedId === conversation.id || conversation.unread
                      ? 700
                      : 400,
                }}
                secondaryTypographyProps={{ variant: "caption", noWrap: true }}
              />
              {conversation.running && (
                <CircularProgress size={12} sx={{ ml: 0.5 }} />
              )}
              {conversation.unread && selectedId !== conversation.id && (
                <Box
                  sx={{
                    ml: 0.75,
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    bgcolor: "primary.main",
                    flexShrink: 0,
                  }}
                />
              )}
            </ListItemButton>
          ))}
        </List>
      ) : (
        <Typography
          variant="caption"
          color="text.disabled"
          sx={{ p: 2, textAlign: "center" }}
        >
          {query.trim() ? "没有匹配的对话" : "还没有 AI 对话"}
        </Typography>
      )}
    </Box>
  );
}
