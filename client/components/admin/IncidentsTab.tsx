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
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
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
import { RemoteIncidentError } from "@/shared/protocol/errors";

export function IncidentsTab({ token }: { token: string }) {
  const [groups, setGroups] = useState<AdminIncidentGroup[]>([]);
  const [environment, setEnvironment] = useState<"" | "server" | "client">("");
  const [buildId, setBuildId] = useState("");
  const [selected, setSelected] = useState<AdminIncidentGroup | null>(null);
  const [details, setDetails] = useState<AdminIncidentDetail[]>([]);
  const [testMessage, setTestMessage] = useState("");

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
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>环境</TableCell>
            <TableCell>Build</TableCell>
            <TableCell>位置</TableCell>
            <TableCell align="right">次数</TableCell>
            <TableCell>最后发生</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {groups.map((group) => (
            <TableRow
              hover
              key={group.id}
              onClick={() => void open(group)}
              sx={{ cursor: "pointer" }}
            >
              <TableCell>{group.environment}</TableCell>
              <TableCell>{group.build_id}</TableCell>
              <TableCell sx={{ maxWidth: 520, overflow: "hidden" }}>
                {group.top_frame}
              </TableCell>
              <TableCell align="right">{group.occurrence_count}</TableCell>
              <TableCell>{group.last_at}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
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
                {detail.public_id} · {detail.occurred_at}
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
