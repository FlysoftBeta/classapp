import React, { useState } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Collapse from "@mui/material/Collapse";
import ButtonBase from "@mui/material/ButtonBase";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";

interface SidebarSectionProps {
  title: string;
  defaultExpanded?: boolean;
  action?: React.ReactNode;
  /** Body scrolls internally inside the section's grid/flex height constraint. */
  scrollable?: boolean;
  /** Relative share of the available sidebar height while expanded. */
  flexWeight?: number;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  children: React.ReactNode;
}

export function SidebarSection({
  title,
  defaultExpanded = true,
  action,
  scrollable = false,
  flexWeight = 1,
  expanded: expandedProp,
  onExpandedChange,
  children,
}: SidebarSectionProps) {
  const [expandedState, setExpandedState] = useState(defaultExpanded);
  const expanded = expandedProp ?? expandedState;

  const toggleExpanded = () => {
    const next = !expanded;
    if (expandedProp === undefined) {
      setExpandedState(next);
    }
    onExpandedChange?.(next);
  };

  const header = (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        width: "100%",
        minWidth: 0,
        px: 1,
        py: 0.5,
        minHeight: 32,
      }}
    >
      <ButtonBase
        type="button"
        onClick={toggleExpanded}
        aria-expanded={expanded}
        focusRipple
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-start",
          flex: 1,
          minWidth: 0,
          border: "none",
          bgcolor: "transparent",
          cursor: "pointer",
          borderRadius: 1,
          px: 0.5,
          py: 0.25,
          textAlign: "left",
          color: "inherit",
          "&:hover": { bgcolor: "action.hover" },
          "&:focus-visible": {
            outline: "2px solid",
            outlineColor: "primary.main",
            outlineOffset: -2,
          },
        }}
      >
        <Box
          component="span"
          aria-hidden
          sx={{
            display: "inline-flex",
            p: 0.25,
            mr: 0.25,
            transform: expanded ? "rotate(0deg)" : "rotate(-90deg)",
            transition: "transform 0.2s",
          }}
        >
          <ExpandMoreIcon sx={{ fontSize: 16, color: "text.disabled" }} />
        </Box>
        <Typography
          variant="caption"
          sx={{
            color: "text.disabled",
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: 0.5,
            fontSize: 10,
          }}
        >
          {title}
        </Typography>
      </ButtonBase>
      {action}
    </Box>
  );

  if (scrollable) {
    return (
      <Box
        sx={{
          width: "100%",
          maxWidth: "100%",
          minWidth: 0,
          minHeight: 0,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          flexGrow: expanded ? flexWeight : 0,
          flexBasis: expanded ? "0px" : "32px",
          flexShrink: expanded ? 1 : 0,
          transition: (theme) =>
            theme.transitions.create(["flex-grow", "flex-basis"], {
              duration: theme.transitions.duration.shorter,
              easing: theme.transitions.easing.easeInOut,
            }),
        }}
      >
        {header}
        <Collapse
          in={expanded}
          timeout={200}
          unmountOnExit
          sx={{
            flex: 1,
            width: "100%",
            maxWidth: "100%",
            minWidth: 0,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            "&.MuiCollapse-entered": {
              overflow: "hidden",
            },
            "& .MuiCollapse-wrapper": {
              flex: 1,
              width: "100%",
              maxWidth: "100%",
              minWidth: 0,
              minHeight: 0,
            },
            "& .MuiCollapse-wrapperInner": {
              flex: 1,
              width: "100%",
              maxWidth: "100%",
              minWidth: 0,
              minHeight: 0,
              display: "flex",
              flexDirection: "column",
            },
          }}
        >
          <Box
            sx={{
              flex: 1,
              width: "100%",
              maxWidth: "100%",
              minWidth: 0,
              minHeight: 0,
              overflowY: "auto",
              overflowX: "hidden",
            }}
          >
            {children}
          </Box>
        </Collapse>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        width: "100%",
        maxWidth: "100%",
        minWidth: 0,
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      {header}
      <Collapse in={expanded} timeout="auto" unmountOnExit={false}>
        {children}
      </Collapse>
    </Box>
  );
}
