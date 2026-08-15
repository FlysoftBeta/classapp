import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import type { User } from "@/shared/types/api";
import { ADMIN_ROLE_DESCRIPTIONS, ADMIN_ROLE_LABELS } from "@/shared/authority";

export function AdminOverview({ currentUser }: { currentUser: User }) {
  return (
    <Box sx={{ maxWidth: 980 }}>
      <Typography variant="h5" fontWeight={700}>
        管理工作台
      </Typography>
      <Typography color="text.secondary" sx={{ mt: 0.5, mb: 2.5 }}>
        工作台按管理职责组织。这里的角色决定可执行的管理操作；普通产品功能在人员页面独立配置。
      </Typography>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle1" fontWeight={700}>
          你的职责
        </Typography>
        <Box sx={{ display: "grid", gap: 1.25, mt: 1.5 }}>
          {currentUser.administration.roles.map((role) => (
            <Box
              key={role}
              sx={{
                display: "grid",
                gridTemplateColumns: "minmax(130px, auto) 1fr",
                gap: 1.5,
                alignItems: "start",
              }}
            >
              <Chip
                size="small"
                label={ADMIN_ROLE_LABELS[role]}
                color={role === "root" ? "primary" : "default"}
              />
              <Typography variant="body2" color="text.secondary">
                {ADMIN_ROLE_DESCRIPTIONS[role]}
              </Typography>
            </Box>
          ))}
        </Box>
      </Paper>
    </Box>
  );
}
