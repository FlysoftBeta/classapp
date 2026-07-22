import type { ReactNode } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import ClientIdBadge from "./ClientIdBadge";
import { vh } from "@/client/lib/css";

export default function AuthScreen({
  title,
  description,
  clientId,
  children,
}: {
  title: string;
  description: string;
  clientId: string;
  children: ReactNode;
}) {
  return (
    <Box
      sx={{
        minHeight: vh(1),
        bgcolor: "background.default",
        display: "grid",
        placeItems: "center",
        px: 2,
        py: { xs: 3, sm: 5 },
      }}
    >
      <Box sx={{ width: "100%", maxWidth: 400, textAlign: "center" }}>
        <Typography variant="h6" sx={{ fontWeight: 600 }}>
          {title}
        </Typography>
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ mt: 0.75, mb: 2 }}
        >
          {description}
        </Typography>
        {children}
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: "block", mt: 2 }}
        >
          如遇到问题，请将右下角的客户端 ID 提供给管理员。
        </Typography>
      </Box>
      <ClientIdBadge clientId={clientId} />
    </Box>
  );
}
