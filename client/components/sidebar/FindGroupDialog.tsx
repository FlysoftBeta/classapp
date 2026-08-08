import React, { useState, useCallback } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import Alert from "@mui/material/Alert";
import CircularProgress from "@mui/material/CircularProgress";
import LockIcon from "@mui/icons-material/Lock";
import { DialogTitleWithHelp } from "@/client/components/shared/HelpTip";
import {
  discoverGroups,
  joinGroup,
  type DiscoverySection,
} from "@/client/api/groups";

export type { DiscoverySection };

export function FindGroupDialog({
  open,
  onClose,
  onJoined,
}: {
  open: boolean;
  onClose: () => void;
  onJoined: (g: { id: string; name: string }) => void;
}) {
  const [q, setQ] = useState("");
  const [sections, setSections] = useState<DiscoverySection[]>([]);
  const [loading, setLoading] = useState(false);
  const [joinTarget, setJoinTarget] = useState<{
    id: string;
    handle: string;
    name: string;
    has_password: number;
    source_group_id: string;
  } | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [joining, setJoining] = useState(false);

  const loadSections = React.useCallback(async (query: string) => {
    setLoading(true);
    const d = await discoverGroups(query);
    setLoading(false);
    if (d) {
      setSections(d.sections || []);
    }
  }, []);

  const handleOpen = useCallback(() => {
    void loadSections("");
  }, [loadSections]);

  const reset = () => {
    setQ("");
    setSections([]);
    setJoinTarget(null);
    setPassword("");
    setError("");
  };

  const handleSearch = () => loadSections(q);

  const handleJoin = async (g: {
    id: string;
    handle: string;
    name: string;
    has_password: number;
    source_group_id: string;
  }) => {
    if (g.has_password && !password) {
      setJoinTarget(g);
      setError("");
      return;
    }
    setJoining(true);
    setError("");
    const { res, data } = await joinGroup(
      g.id,
      { type: "group", groupId: g.source_group_id },
      password || undefined,
    );
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
    onJoined({ id: g.id, name: g.name });
    reset();
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      slotProps={{ transition: { onEnter: handleOpen } }}
      maxWidth="xs"
      fullWidth
    >
      <DialogTitleWithHelp help="搜索并加入你能看到的群组。可直接输入群组 handle 精确定位，或浏览父群组下挂载的可发现群组列表。">
        发现群组
      </DialogTitleWithHelp>
      <DialogContent>
        <Box sx={{ display: "flex", alignItems: "center", mt: 1 }}>
          <TextField
            size="small"
            placeholder="输入 handle 或群组名称…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSearch();
            }}
            sx={{ flex: 1, mr: 1 }}
          />
          <Button
            variant="outlined"
            size="small"
            onClick={handleSearch}
            disabled={loading}
          >
            {loading ? <CircularProgress size={16} /> : "搜索"}
          </Button>
        </Box>

        {loading && sections.length === 0 ? (
          <Box sx={{ py: 2, textAlign: "center" }}>
            <CircularProgress size={20} />
          </Box>
        ) : sections.length === 0 ? (
          <Typography
            variant="caption"
            color="text.disabled"
            sx={{ display: "block", py: 1 }}
          >
            {q.trim() ? "无匹配结果" : "暂无可发现的群组，请先加入父群组"}
          </Typography>
        ) : (
          sections.map((section) => (
            <Box key={section.parent.id} sx={{ mt: 1.5 }}>
              <Typography
                variant="caption"
                color="text.disabled"
                sx={{
                  display: "block",
                  mb: 0.5,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                  fontSize: 10,
                }}
              >
                来自 {section.parent.name}
              </Typography>
              {section.groups.map((g) => (
                <Box
                  key={g.id}
                  sx={{
                    mt: 0.75,
                    p: 1.5,
                    borderRadius: 1,
                    bgcolor: "action.hover",
                    display: "flex",
                    alignItems: "center",
                  }}
                >
                  <Box sx={{ flex: 1 }}>
                    <Typography variant="body2" fontWeight={600}>
                      {g.name}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      @{g.handle ?? g.id}
                    </Typography>
                    {g.has_password ? (
                      <LockIcon
                        sx={{
                          fontSize: 12,
                          ml: 0.5,
                          color: "text.secondary",
                          verticalAlign: "middle",
                        }}
                      />
                    ) : null}
                  </Box>
                  <Button
                    size="small"
                    variant="contained"
                    onClick={() =>
                      handleJoin({ ...g, source_group_id: section.parent.id })
                    }
                    disabled={joining}
                  >
                    加入
                  </Button>
                </Box>
              ))}
            </Box>
          ))
        )}

        {joinTarget && joinTarget.has_password && (
          <Box sx={{ mt: 1.5 }}>
            <Typography variant="caption" color="text.secondary">
              该群组需要密码：
            </Typography>
            <TextField
              autoFocus
              size="small"
              type="password"
              fullWidth
              sx={{ mt: 0.5 }}
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
        <Button
          onClick={() => {
            reset();
            onClose();
          }}
        >
          关闭
        </Button>
      </DialogActions>
    </Dialog>
  );
}
