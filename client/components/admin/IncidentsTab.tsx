import React, { useCallback, useEffect, useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import {
  adminFetchIncidentDetails,
  adminFetchIncidentGroups,
  adminIncidentLogsDownloadUrl,
  adminTestServerIncident,
  type AdminIncidentDetail,
  type AdminIncidentGroup,
} from "@/client/api/admin";
import { captureClientOperation } from "@/client/interact/clientIncidents";
import { formatDeviceDateTime } from "@/client/lib/deviceTime";
import { RemoteIncidentError } from "@/shared/protocol/errors";
import { AdminDataGrid, type AdminGridColumn } from "./AdminDataGrid";

export function IncidentsTab({ token }: { token: string }) {
  const [groups, setGroups] = useState<AdminIncidentGroup[]>([]);
  const [environment, setEnvironment] = useState<"" | "server" | "client">("");
  const [buildId, setBuildId] = useState("");
  const [selected, setSelected] = useState<AdminIncidentGroup | null>(null);
  const [details, setDetails] = useState<AdminIncidentDetail[]>([]);
  const [testMessage, setTestMessage] = useState("");
  const columns: AdminGridColumn<AdminIncidentGroup>[] = [
    { id: "id", label: "ID", width: 110, render: (group) => group.id },
    {
      id: "environment",
      label: "环境",
      width: 100,
      render: (group) => group.environment,
    },
    {
      id: "build",
      label: "Build",
      width: 180,
      render: (group) => group.build_id,
      longText: (group) => group.build_id,
    },
    {
      id: "location",
      label: "位置",
      width: 520,
      render: (group) => group.top_frame,
      longText: (group) => group.top_frame,
    },
    {
      id: "count",
      label: "次数",
      width: 90,
      render: (group) => group.occurrence_count,
    },
    {
      id: "last",
      label: "最后发生",
      width: 180,
      render: (group) => formatDeviceDateTime(group.last_at, true),
    },
  ];

  const refresh = useCallback(async () => {
    setGroups(
      await adminFetchIncidentGroups({
        ...(environment ? { environment } : {}),
        ...(buildId.trim() ? { buildId: buildId.trim() } : {}),
      }),
    );
  }, [buildId, environment]);

  useEffect(() => {
    let active = true;
    void adminFetchIncidentGroups({}).then((items) => {
      if (active) setGroups(items);
    });
    return () => {
      active = false;
    };
  }, []);

  const open = async (group: AdminIncidentGroup) => {
    setSelected(group);
    setDetails(await adminFetchIncidentDetails(group.id));
  };

  const testServer = async () => {
    try {
      await adminTestServerIncident();
    } catch (error) {
      setTestMessage(
        error instanceof RemoteIncidentError
          ? `Server Incident: ${error.incidentIds.join(", ")}`
          : error instanceof Error
            ? error.message
            : String(error),
      );
      await refresh();
    }
  };

  const testClient = async () => {
    try {
      await captureClientOperation("admin.client-incident-test", async () => {
        throw new Error("Manual client Incident test");
      });
    } catch {
      setTestMessage("Client Incident 已上报");
      await refresh();
    }
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
        <FormControl size="small" sx={{ minWidth: 140 }}>
          <InputLabel>环境</InputLabel>
          <Select
            label="环境"
            value={environment}
            onChange={(event) =>
              setEnvironment(event.target.value as typeof environment)
            }
          >
            <MenuItem value="">全部</MenuItem>
            <MenuItem value="server">Server</MenuItem>
            <MenuItem value="client">Client</MenuItem>
          </Select>
        </FormControl>
        <TextField
          size="small"
          label="Build ID"
          value={buildId}
          onChange={(event) => setBuildId(event.target.value)}
        />
        <Button variant="outlined" onClick={() => void refresh()}>
          刷新
        </Button>
        <Button
          variant="outlined"
          onClick={() =>
            window.open(adminIncidentLogsDownloadUrl(token), "_blank")
          }
        >
          下载当前 Build 日志
        </Button>
        <Button variant="outlined" color="warning" onClick={testServer}>
          触发 Server Incident
        </Button>
        <Button variant="outlined" color="warning" onClick={testClient}>
          触发 Client Incident
        </Button>
      </Box>
      {testMessage && <Typography variant="body2">{testMessage}</Typography>}
      <AdminDataGrid
        rows={groups}
        columns={columns}
        rowKey={(group) => group.id}
        onRowClick={(group) => void open(group)}
      />
      <Dialog
        open={!!selected}
        onClose={() => setSelected(null)}
        maxWidth="lg"
        fullWidth
      >
        <DialogTitle>{selected?.top_frame}</DialogTitle>
        <DialogContent>
          {details.map((detail) => (
            <Box key={detail.id} sx={{ mb: 3 }}>
              <Typography variant="subtitle2">
                {detail.public_id} ·{" "}
                {formatDeviceDateTime(detail.occurred_at, true)}
              </Typography>
              {detail.message && <Typography>{detail.message}</Typography>}
              {detail.related_incident_ids.length > 0 && (
                <Typography variant="caption">
                  Related: {detail.related_incident_ids.join(", ")}
                </Typography>
              )}
              {detail.stack && (
                <Box
                  component="pre"
                  sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                >
                  {detail.stack}
                </Box>
              )}
            </Box>
          ))}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSelected(null)}>关闭</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
