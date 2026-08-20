import React from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { flexGap } from "@/client/lib/css";

export function LibrarySection({
  title,
  empty,
  children,
}: {
  title: string;
  empty?: string;
  children: React.ReactNode;
}) {
  const isEmpty = React.Children.count(children) === 0;
  return (
    <Box sx={{ px: 0.5 }}>
      <Typography
        variant="caption"
        sx={{
          px: 1.5,
          pt: 1.5,
          pb: 0.5,
          display: "block",
          color: "text.disabled",
          fontWeight: 600,
          letterSpacing: 0.5,
          fontSize: 10,
        }}
      >
        {title}
      </Typography>
      {isEmpty ? (
        <Typography
          variant="body2"
          color="text.disabled"
          sx={{ px: 1.5, py: 1 }}
        >
          {empty ?? "暂无内容"}
        </Typography>
      ) : (
        <Box sx={{ display: "flex", flexDirection: "column", ...flexGap(0.25) }}>
          {children}
        </Box>
      )}
    </Box>
  );
}
