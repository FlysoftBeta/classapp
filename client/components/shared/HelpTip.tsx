import React from "react";
import Tooltip from "@mui/material/Tooltip";
import IconButton from "@mui/material/IconButton";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";

/**
 * HelpTip — small "?" icon with a tooltip.
 *
 * Used both at the top-right of every Dialog (describing the dialog as a
 * whole) and next to individual option labels (describing the option's
 * effect). Keeps tooltips consistent without each call site re-styling.
 */
export function HelpTip({
  title,
  size = "small",
}: {
  title: React.ReactNode;
  size?: "small" | "medium";
}) {
  return (
    <Tooltip
      arrow
      enterTouchDelay={50}
      leaveTouchDelay={5000}
      title={
        <Box sx={{ maxWidth: 260, py: 0.5 }}>
          {typeof title === "string" ? (
            <Typography
              variant="caption"
              sx={{ display: "block", lineHeight: 1.5 }}
            >
              {title}
            </Typography>
          ) : (
            title
          )}
        </Box>
      }
    >
      <IconButton
        size={size}
        sx={{ p: size === "small" ? 0.25 : 0.5, color: "text.disabled" }}
        aria-label="详细说明"
      >
        <HelpOutlineIcon fontSize={size === "small" ? "inherit" : "small"} />
      </IconButton>
    </Tooltip>
  );
}

/**
 * DialogTitleWithHelp — a DialogTitle replacement that places a help icon
 * at the top-right corner describing the dialog's purpose.
 *
 * Usage:
 *   <DialogTitleWithHelp help="说明该 Dialog 的整体作用">标题</DialogTitleWithHelp>
 */
export function DialogTitleWithHelp({
  children,
  help,
}: {
  children: React.ReactNode;
  help: React.ReactNode;
}) {
  return (
    <Box
      sx={{
        px: 3,
        pt: 2,
        pb: 1,
        display: "flex",
        alignItems: "center",
        gap: 1,
      }}
    >
      <Typography variant="h6" sx={{ flex: 1, fontSize: 18, fontWeight: 600 }}>
        {children}
      </Typography>
      <HelpTip title={help} />
    </Box>
  );
}

/**
 * LabelWithHelp — option label + inline help icon, for use next to switches,
 * radio buttons, or text-field labels.
 */
export function LabelWithHelp({
  label,
  help,
}: {
  label: React.ReactNode;
  help: React.ReactNode;
}) {
  return (
    <Box sx={{ display: "inline-flex", alignItems: "center", gap: 0.25 }}>
      <Box component="span">{label}</Box>
      <HelpTip title={help} />
    </Box>
  );
}
