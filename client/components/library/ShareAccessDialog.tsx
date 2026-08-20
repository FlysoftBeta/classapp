import React, { useMemo, useState } from "react";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import ListItemText from "@mui/material/ListItemText";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import {
  ALL_ACCESS_GRANTS,
  flagsCanIssue,
  grantKey,
  type AccessFlags,
  type AccessGrant,
  type AccessBindingView,
  type PrincipalRef,
} from "@/shared/access";
import { useApplicationStore } from "@/client/interact/appStore";

function grantLabel(grant: AccessGrant): string {
  if (grant.mode === "owner") return "可管理";
  const mode = grant.mode === "readwrite" ? "可编辑" : "可查看";
  return grant.shareable ? `${mode}（可转授）` : mode;
}

function principalLabel(
  principal: PrincipalRef,
  names: Map<string, string>,
): string {
  const name = names.get(`${principal.kind}:${principal.id}`);
  if (name) return name;
  return principal.kind === "group" ? "群组" : "用户";
}

export function ShareAccessDialog({
  title,
  flags,
  bindings,
  onGrant,
  onRevoke,
  onClose,
}: {
  title: string;
  flags: AccessFlags;
  bindings: AccessBindingView[];
  onGrant: (principal: PrincipalRef, grant: AccessGrant) => Promise<void>;
  onRevoke: (principal: PrincipalRef) => Promise<void>;
  onClose: () => void;
}) {
  const conversations = useApplicationStore((state) => state.conversations);
  const currentUserId = useApplicationStore((state) => state.user?.id);
  const issuable = ALL_ACCESS_GRANTS.filter((grant) =>
    flagsCanIssue(flags, grant),
  );
  const [kind, setKind] = useState<"group" | "user">("group");
  const [principalId, setPrincipalId] = useState("");
  const [grantIndex, setGrantIndex] = useState(0);
  const [busy, setBusy] = useState(false);

  const options = useMemo(() => {
    if (kind === "group") {
      return conversations
        .filter((entry) => entry.type === "group")
        .map((entry) => ({ id: entry.id, label: entry.name }));
    }
    return conversations
      .filter((entry) => entry.type === "dm" && entry.id !== currentUserId)
      .map((entry) => ({ id: entry.id, label: entry.name }));
  }, [conversations, currentUserId, kind]);

  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of conversations) {
      map.set(
        `${entry.type === "group" ? "group" : "user"}:${entry.id}`,
        entry.name,
      );
    }
    return map;
  }, [conversations]);

  const selectedGrant = issuable[grantIndex] ?? issuable[0];

  const submit = async () => {
    if (!principalId || !selectedGrant) return;
    setBusy(true);
    await onGrant({ kind, id: principalId }, selectedGrant);
    setBusy(false);
    setPrincipalId("");
  };

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        {bindings.length === 0 ? (
          <Typography variant="body2" color="text.disabled" sx={{ mb: 2 }}>
            还没有其他访问绑定
          </Typography>
        ) : (
          <List dense disablePadding sx={{ mb: 2 }}>
            {bindings.map((binding) => (
              <ListItem
                key={`${binding.principal.kind}:${binding.principal.id}`}
                secondaryAction={
                  flags.own &&
                  !(
                    binding.principal.kind === "user" &&
                    binding.principal.id === currentUserId
                  ) ? (
                    <Button
                      size="small"
                      onClick={() => void onRevoke(binding.principal)}
                    >
                      移除
                    </Button>
                  ) : null
                }
              >
                <ListItemText
                  primary={principalLabel(binding.principal, names)}
                  secondary={binding.grants.map(grantLabel).join("、")}
                />
              </ListItem>
            ))}
          </List>
        )}
        {issuable.length === 0 ? (
          <Typography variant="body2" color="text.disabled">
            当前权限不可转授
          </Typography>
        ) : (
          <>
            <ToggleButtonGroup
              exclusive
              fullWidth
              size="small"
              value={kind}
              onChange={(_event, value: "group" | "user" | null) => {
                if (value) {
                  setKind(value);
                  setPrincipalId("");
                }
              }}
              sx={{ mb: 2 }}
            >
              <ToggleButton value="group">群组</ToggleButton>
              <ToggleButton value="user">用户</ToggleButton>
            </ToggleButtonGroup>
            <FormControl fullWidth size="small" sx={{ mb: 2 }}>
              <InputLabel>{kind === "group" ? "选择群组" : "选择用户"}</InputLabel>
              <Select
                label={kind === "group" ? "选择群组" : "选择用户"}
                value={principalId}
                onChange={(event) => setPrincipalId(String(event.target.value))}
              >
                {options.length === 0 ? (
                  <MenuItem disabled value="">
                    没有可选对象
                  </MenuItem>
                ) : (
                  options.map((option) => (
                    <MenuItem key={option.id} value={option.id}>
                      {option.label}
                    </MenuItem>
                  ))
                )}
              </Select>
            </FormControl>
            <FormControl fullWidth size="small">
              <InputLabel>授予权限</InputLabel>
              <Select
                label="授予权限"
                value={grantKey(selectedGrant)}
                onChange={(event) => {
                  const index = issuable.findIndex(
                    (grant) => grantKey(grant) === event.target.value,
                  );
                  if (index >= 0) setGrantIndex(index);
                }}
              >
                {issuable.map((grant) => (
                  <MenuItem key={grantKey(grant)} value={grantKey(grant)}>
                    {grantLabel(grant)}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>关闭</Button>
        <Button
          variant="contained"
          disabled={!principalId || !selectedGrant || busy}
          onClick={() => void submit()}
        >
          授予
        </Button>
      </DialogActions>
    </Dialog>
  );
}
