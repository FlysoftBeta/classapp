import { useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import { adminFetchAuditLog, type AdminAuditEntry } from "@/client/api/admin";
import { useActionQuery } from "@/client/hooks/useActionQuery";
import { formatDeviceDateTime } from "@/client/lib/deviceTime";
import { AdminDataGrid, type AdminGridColumn } from "./AdminDataGrid";

export function AuditTab() {
  const [offset, setOffset] = useState(0);
  const { data, loading } = useActionQuery<AdminAuditEntry[]>(
    () => adminFetchAuditLog(offset),
    [offset],
  );
  const columns: AdminGridColumn<AdminAuditEntry>[] = [
    {
      id: "id",
      label: "记录 ID",
      width: 220,
      render: (entry) => entry.id,
      longText: (entry) => entry.id,
    },
    {
      id: "time",
      label: "时间",
      width: 180,
      render: (entry) => formatDeviceDateTime(entry.created_at, true),
    },
    {
      id: "actor",
      label: "执行者",
      width: 150,
      render: (entry) =>
        entry.actor_handle
          ? `@${entry.actor_handle}`
          : (entry.actor_id ?? "已删除"),
    },
    {
      id: "action",
      label: "动作",
      width: 230,
      render: (entry) => entry.action,
    },
    {
      id: "target",
      label: "目标",
      width: 230,
      render: (entry) =>
        `${entry.target_kind}${entry.target_id ? ` · ${entry.target_id}` : ""}`,
      longText: (entry) => entry.target_id,
    },
    {
      id: "details",
      label: "结构化详情",
      width: 480,
      render: (entry) => JSON.stringify(entry.details),
      longText: (entry) => JSON.stringify(entry.details, null, 2),
    },
  ];
  return (
    <Box>
      <Typography variant="h5" fontWeight={700}>
        管理审计
      </Typography>
      <Typography color="text.secondary" sx={{ mt: 0.5, mb: 2 }}>
        记录已经成功完成的高影响管理动作。凭据、PIN 与其他秘密不会写入详情。
      </Typography>
      <AdminDataGrid
        rows={data ?? []}
        columns={columns}
        rowKey={(entry) => entry.id}
        empty={loading ? "加载中…" : "暂无审计记录"}
      />
      <Box sx={{ display: "flex", gap: 1, mt: 1 }}>
        <Button
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - 100))}
        >
          上一页
        </Button>
        <Button
          disabled={(data?.length ?? 0) < 100}
          onClick={() => setOffset(offset + 100)}
        >
          下一页
        </Button>
      </Box>
    </Box>
  );
}
