import React from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import GroupsIcon from "@mui/icons-material/Groups";
import PersonIcon from "@mui/icons-material/Person";
import LockIcon from "@mui/icons-material/Lock";
import PushPinIcon from "@mui/icons-material/PushPin";
import type { ConvEntry } from "@/client/hooks/useAppLogic";

interface ConversationSectionProps {
  conversations: ConvEntry[];
  selected: ConvEntry | null;
  onSelect: (conv: ConvEntry) => void;
}

export function ConversationSection({
  conversations,
  selected,
  onSelect,
}: ConversationSectionProps) {
  const isSelected = (type: "group" | "dm", id: string) =>
    selected?.type === type && selected?.id === id;

  if (conversations.length === 0) {
    return (
      <Box sx={{ px: 1.5, py: 1.5, textAlign: "center" }}>
        <Typography variant="caption" color="text.disabled">
          还没有对话
        </Typography>
      </Box>
    );
  }

  return (
    <List
      disablePadding
      dense
      sx={{ width: "100%", maxWidth: "100%", minWidth: 0, pb: 0.5 }}
    >
      {conversations.map((c) => {
        const unread = !isSelected(c.type, c.id) && (c.unread_count ?? 0) > 0;
        const Icon = c.type === "group" ? GroupsIcon : PersonIcon;
        return (
          <ListItemButton
            key={`${c.type}:${c.id}`}
            selected={isSelected(c.type, c.id)}
            onClick={() => onSelect(c)}
            sx={{ px: 1.5, py: 0.75, borderRadius: 1, mx: 0.5 }}
          >
            <Icon
              sx={{
                mr: 1,
                fontSize: 16,
                color: "text.secondary",
                flexShrink: 0,
              }}
            />
            <ListItemText
              sx={{ minWidth: 0 }}
              primary={c.name}
              secondary={
                c.last_message
                  ? c.last_message.slice(0, 28) +
                    (c.last_message.length > 28 ? "…" : "")
                  : null
              }
              primaryTypographyProps={{
                variant: "body2",
                fontWeight: isSelected(c.type, c.id) || unread ? 700 : 400,
                noWrap: true,
              }}
              secondaryTypographyProps={{
                variant: "caption",
                noWrap: true,
              }}
            />
            {c.pinned ? (
              <PushPinIcon
                sx={{
                  fontSize: 14,
                  ml: 0.5,
                  color: "text.disabled",
                  flexShrink: 0,
                }}
              />
            ) : null}
            {c.has_password ? (
              <LockIcon
                sx={{
                  fontSize: 12,
                  ml: 0.5,
                  color: "text.disabled",
                  flexShrink: 0,
                }}
              />
            ) : null}
            {unread && (
              <Box
                sx={{
                  ml: 0.5,
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  bgcolor: "primary.main",
                  flexShrink: 0,
                }}
              />
            )}
          </ListItemButton>
        );
      })}
    </List>
  );
}
