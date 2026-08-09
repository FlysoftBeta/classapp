import React, { useState } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import Chip from "@mui/material/Chip";
import Alert from "@mui/material/Alert";
import Switch from "@mui/material/Switch";
import FormControlLabel from "@mui/material/FormControlLabel";
import CircularProgress from "@mui/material/CircularProgress";
import PeopleIcon from "@mui/icons-material/People";
import ExitToAppIcon from "@mui/icons-material/ExitToApp";
import {
  fetchGroupMembers,
  leaveGroup,
  patchMyGroupMembership,
  type GroupMember,
} from "@/client/interact/groups";
export function MembersDialog({
  groupId,
  currentUserId,
  onStartDm,
  onLeft,
}: {
  groupId: string;
  currentUserId: string;
  onStartDm: (id: string, name: string) => void;
  onLeft: (groupId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [hidden, setHidden] = useState(false);
  const [loading, setLoading] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveErr, setLeaveErr] = useState("");
  const [noLeave, setNoLeave] = useState(false);
  const [selfHideSelf, setSelfHideSelf] = useState(false);
  const [hideSaving, setHideSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    const d = await fetchGroupMembers(groupId);
    setLoading(false);
    if (d) {
      setMembers(d.members || []);
      setHidden(!!d.hidden);
      setNoLeave(!!d.no_leave);
      setSelfHideSelf(!!d.self_hide_self);
    }
  };

  const handleToggleHideSelf = async (checked: boolean) => {
    setHideSaving(true);
    const res = await patchMyGroupMembership(groupId, {
      hide_self: checked,
    });
    setHideSaving(false);
    if (res.ok) {
      setSelfHideSelf(checked);
      load();
    }
  };

  const handleOpen = () => {
    setOpen(true);
    load();
  };

  const handleLeave = async () => {
    setLeaving(true);
    const { res, data } = await leaveGroup(groupId);
    setLeaving(false);
    if (!res.ok) {
      setLeaveErr(data.error || "退出失败");
      return;
    }
    setOpen(false);
    onLeft(groupId);
  };

  return (
    <>
      <Tooltip title="成员">
        <IconButton size="small" onClick={handleOpen}>
          <PeopleIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle sx={{ display: "flex", alignItems: "center" }}>
          成员
          {!noLeave && (
            <Box sx={{ ml: "auto" }}>
              <Button
                size="small"
                color="error"
                startIcon={<ExitToAppIcon />}
                onClick={handleLeave}
                disabled={leaving}
              >
                退出群组
              </Button>
            </Box>
          )}
        </DialogTitle>
        <DialogContent>
          {leaveErr && (
            <Alert severity="error" sx={{ mb: 1 }}>
              {leaveErr}
            </Alert>
          )}
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={selfHideSelf}
                disabled={hideSaving}
                onChange={(e) => handleToggleHideSelf(e.target.checked)}
              />
            }
            label="在成员列表中隐藏自己"
            sx={{ mb: 1, display: "block" }}
          />
          {loading ? (
            <CircularProgress size={24} />
          ) : hidden ? (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ py: 2, textAlign: "center" }}
            >
              该群组的成员列表已隐藏
            </Typography>
          ) : (
            <List dense disablePadding>
              {members.map((m) => (
                <ListItem key={m.id} sx={{ px: 0 }}>
                  <ListItemText
                    primary={
                      <>
                        {m.username}
                        {m.id === currentUserId && selfHideSelf && (
                          <Chip
                            label="已隐藏"
                            size="small"
                            sx={{ ml: 0.75, height: 18, fontSize: 10 }}
                          />
                        )}
                      </>
                    }
                    secondary={`@${m.handle}`}
                    primaryTypographyProps={{
                      variant: "body2",
                      component: "div",
                    }}
                  />
                  {m.id !== currentUserId && (
                    <Button
                      size="small"
                      variant="text"
                      onClick={() => {
                        onStartDm(m.id, m.handle);
                        setOpen(false);
                      }}
                    >
                      私信
                    </Button>
                  )}
                </ListItem>
              ))}
            </List>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
