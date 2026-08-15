import type { ReactElement, ReactNode } from "react";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import CloseIcon from "@mui/icons-material/Close";

export function SelectionActionBar({
  label,
  children,
  onClear,
}: {
  label: ReactNode;
  children: ReactNode;
  onClear: () => void;
}) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
      <Typography variant="body2" sx={{ whiteSpace: "nowrap", mr: 0.5 }}>
        {label}
      </Typography>
      {children}
      <Divider orientation="vertical" flexItem sx={{ mx: 0.25 }} />
      <SelectionActionIcon label="取消选择" onClick={onClear}>
        <CloseIcon fontSize="small" />
      </SelectionActionIcon>
    </Box>
  );
}

export function SelectionActionIcon({
  label,
  children,
  onClick,
  color = "default",
  disabled = false,
}: {
  label: string;
  children: ReactElement;
  onClick: () => void;
  color?: "default" | "primary" | "error" | "warning";
  disabled?: boolean;
}) {
  return (
    <Tooltip title={label}>
      <span>
        <IconButton
          size="small"
          color={color}
          disabled={disabled}
          aria-label={label}
          onClick={onClick}
        >
          {children}
        </IconButton>
      </span>
    </Tooltip>
  );
}
