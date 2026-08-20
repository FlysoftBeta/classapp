import React, { type ReactNode } from "react";
import Box from "@mui/material/Box";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import { flexGap } from "@/client/lib/css";

export function AccessibleListRow({
  title,
  subtitle,
  coverUrl,
  icon,
  onOpen,
}: {
  title: string;
  subtitle: string;
  coverUrl?: string | null;
  icon: ReactNode;
  onOpen: () => void;
}) {
  return (
    <ListItemButton
      onClick={onOpen}
      sx={{ borderRadius: 2, mx: 0.5, width: "calc(100% - 8px)" }}
    >
      {coverUrl ? (
        <Box
          component="img"
          alt=""
          src={coverUrl}
          sx={{
            width: 40,
            height: 40,
            borderRadius: 1,
            mr: 1,
            objectFit: "cover",
            flexShrink: 0,
          }}
        />
      ) : (
        <Box
          sx={{
            width: 40,
            height: 40,
            borderRadius: 1,
            bgcolor: "action.hover",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            mr: 1,
            flexShrink: 0,
            ...flexGap(0),
          }}
        >
          {icon}
        </Box>
      )}
      <ListItemText
        primary={title}
        secondary={subtitle}
        primaryTypographyProps={{ noWrap: true, variant: "body2" }}
        secondaryTypographyProps={{ noWrap: true, variant: "caption" }}
      />
    </ListItemButton>
  );
}
