import React, { useState } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import Alert from "@mui/material/Alert";
import CircularProgress from "@mui/material/CircularProgress";
import TextField from "@mui/material/TextField";
import ExploreIcon from "@mui/icons-material/Explore";
import { discoverSubgroups, joinGroup } from "@/client/api/groups";

export interface DiscoverGroup {
  id: string;
  name: string;
  has_password: number;
}

export function DiscoverGroupsDialog({
  groupId,
  groupName,
  onJoined,
}: {
  groupId: string;
  groupName: string;
  onJoined: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<DiscoverGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [joinTarget, setJoinTarget] = useState<DiscoverGroup | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [joining, setJoining] = useState(false);

  const load = async () => {
    setLoading(true);
    setError("");
    const d = await discoverSubgroups(groupId);
    setLoading(false);
    if (d) {
      setGroups(d.groups || []);
    }
  };

  const handleOpen = () => {
    setOpen(true);
    setJoinTarget(null);
    setPassword("");
    load();
  };

  const handleJoin = async (g: DiscoverGroup) => {
    if (g.has_password && !password) {
      setJoinTarget(g);
      setError("");
      return;
    }
    setJoining(true);
    setError("");
    const { res, data } = await joinGroup(g.id, password || undefined);
    setJoining(false);
    if (!res.ok) {
      if (data.needs_password) {
        setJoinTarget(g);
        setError("");
        return;
      }
      setError(data.error || "加入失败");
      return;
    }
    setOpen(false);
    setJoinTarget(null);
    setPassword("");
    onJoined();
  };

  return (
    <>
      <Tooltip title="发现群组">
        <IconButton size="small" onClick={handleOpen}>
          <ExploreIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>发现群组 — {groupName}</DialogTitle>
        <DialogContent>
          {loading ? (
            <CircularProgress
              size={24}
              sx={{ display: "block", mx: "auto", my: 2 }}
            />
          ) : groups.length === 0 ? (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ py: 2, textAlign: "center" }}
            >
              暂无关联群组
            </Typography>
          ) : (
            <List dense disablePadding>
              {groups.map((g) => (
                <ListItem
                  key={g.id}
                  sx={{ px: 0, display: "flex", alignItems: "center", gap: 1 }}
                  secondaryAction={
                    <Button
                      size="small"
                      variant="contained"
                      onClick={() => handleJoin(g)}
                      disabled={joining}
                    >
                      加入
                    </Button>
                  }
                >
                  <ListItemText
                    primary={g.name}
                    secondary={`#${g.id}`}
                    primaryTypographyProps={{ variant: "body2" }}
                  />
                </ListItem>
              ))}
            </List>
          )}
          {joinTarget && joinTarget.has_password && (
            <Box sx={{ mt: 1.5 }}>
              <TextField
                autoFocus
                size="small"
                type="password"
                fullWidth
                label="群组密码"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleJoin(joinTarget);
                }}
              />
              <Button
                sx={{ mt: 1 }}
                variant="contained"
                size="small"
                onClick={() => handleJoin(joinTarget)}
                disabled={joining || !password}
              >
                确认加入
              </Button>
            </Box>
          )}
          {error && (
            <Alert severity="error" sx={{ mt: 1 }}>
              {error}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>关闭</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
