import { useState } from "react";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Typography from "@mui/material/Typography";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import CheckIcon from "@mui/icons-material/Check";

export default function ClientIdBadge({ clientId }: { clientId: string }) {
  const [copied, setCopied] = useState(false);
  if (!clientId) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(clientId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* The ID remains selectable when clipboard access is unavailable. */
    }
  };

  return (
    <Box
      sx={{
        position: "fixed",
        right: { xs: 12, sm: 20 },
        bottom: { xs: 10, sm: 16 },
        color: "text.secondary",
        zIndex: 2,
      }}
    >
      <ButtonBase
        onClick={() => void copy()}
        title="复制客户端 ID"
        sx={{
          display: "flex",
          gap: 0.75,
          alignItems: "center",
          px: 1.25,
          py: 0.75,
          borderRadius: 2,
          bgcolor: "action.hover",
        }}
      >
        <Box sx={{ textAlign: "right" }}>
          <Typography sx={{ fontSize: 10, lineHeight: 1.1 }}>
            客户端 ID
          </Typography>
          <Typography
            sx={{
              mt: 0.25,
              fontFamily: "monospace",
              fontSize: 12,
              lineHeight: 1.2,
              userSelect: "text",
            }}
          >
            {clientId}
          </Typography>
        </Box>
        {copied ? (
          <CheckIcon sx={{ fontSize: 15 }} />
        ) : (
          <ContentCopyIcon sx={{ fontSize: 15 }} />
        )}
      </ButtonBase>
    </Box>
  );
}
