import React from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import AddIcon from "@mui/icons-material/Add";
import SearchIcon from "@mui/icons-material/Search";

interface SidebarTopProps {
  onFindGroup: () => void;
  onCreateGroup: () => void;
  online: boolean;
}

export function SidebarTopProps({
  onFindGroup,
  onCreateGroup,
  online,
}: SidebarTopProps) {
  return (
    <Box
      sx={{
        px: 1.5,
        py: 1,
        display: "flex",
        alignItems: "center",
        borderBottom: "1px solid",
        borderColor: "divider",
      }}
    >
      <Typography variant="subtitle2" sx={{ flex: 1, fontWeight: 700 }}>
        Baker
      </Typography>
      <Tooltip title="发现群组">
        <span>
          <IconButton size="small" onClick={onFindGroup} disabled={!online}>
            <SearchIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      <Tooltip title="创建群组">
        <span>
          <IconButton size="small" onClick={onCreateGroup} disabled={!online}>
            <AddIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
    </Box>
  );
}
