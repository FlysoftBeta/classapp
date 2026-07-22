import React, { useState, useCallback } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import Divider from "@mui/material/Divider";
import Alert from "@mui/material/Alert";
import Switch from "@mui/material/Switch";
import FormControlLabel from "@mui/material/FormControlLabel";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import CircularProgress from "@mui/material/CircularProgress";

import IconButton from "@mui/material/IconButton";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import NumPad from "@/client/components/shared/NumPad";
import type { User } from "@/shared/types/api";
import { getClientMe, updateMe } from "@/client/api/auth";
import { updateDoNotDisturb } from "@/client/api/notificationConfig";
import EndfieldLogo from "../EndfieldLogo";
import { useTheme } from "@mui/material/styles";

interface SettingsProps {
  currentUser: User;
  themeMode: "light" | "dark";
  onThemeToggle: () => void;
  onUserUpdated: (user: User) => void;
  onLogout: () => void;
  onBack?: () => void;
  doNotDisturb: boolean;
  onDoNotDisturbChange: (enabled: boolean) => void;
  online: boolean;
}

type PinResetStep =
  "idle" | "verify" | "new1" | "new2_prompt" | "new2" | "done";

async function about() {
  const { res, data } = await getClientMe();
  const ip = res.ok && !("error" in data) ? data.ip : "获取失败";
  const clientId =
    res.ok && !("error" in data) ? (data.client_id ?? "未知") : "获取失败";
  const buildId = res.meta.buildId || "未知";
  alert(`爱来自 Flysoft 喵。

“终末地工业”是塔卫二著名的技术承包商之一，积极参与塔卫二的开拓，在荒地上建立完整的能源和技术生产线是终末地工业现阶段的重点工作目标之一。“协议回收部门”曾经是终末地工业最重要的核心部门，但是数年前的一次“意外冲突”摧毁了协议回收部门的中央基地，部门负责人与大量成员遇难，使终末地工业被迫暂停技术回收的工作。伴随着塔卫二各大势力重新开始探索遗迹，协议回收部门在监督佩丽卡的带领下重建，并成功研发了“自动化集成工业系统”。为了证明该系统的传送技术的可靠性，协议回收部门选择了开拓区中环境最恶劣，资源最匮乏的“四号谷地”作为目标，尝试以此为基础逐步向外探索。

诊断信息:
- Build-ID: ${buildId}
- User-Agent: ${navigator.userAgent}
- IP: ${ip}
- 客户端 ID: ${clientId}`);
}

export default function Settings({
  currentUser,
  themeMode,
  onThemeToggle,
  onUserUpdated,
  onLogout,
  onBack,
  doNotDisturb,
  onDoNotDisturbChange,
  online,
}: SettingsProps) {
  const [handle, setHandle] = useState(currentUser.handle);
  const [handleMsg, setHandleMsg] = useState("");
  const [handleErr, setHandleErr] = useState("");
  const [savingHandle, setSavingHandle] = useState(false);

  const [username, setUsername] = useState(currentUser.username);
  const [usernameMsg, setUsernameMsg] = useState("");
  const [usernameErr, setUsernameErr] = useState("");
  const [savingUsername, setSavingUsername] = useState(false);

  // PIN reset flow
  const [pinDialogOpen, setPinDialogOpen] = useState(false);
  const [pinStep, setPinStep] = useState<PinResetStep>("idle");
  const [currentPin, setCurrentPin] = useState("");
  const [newPin1, setNewPin1] = useState("");
  const [pinLoading, setPinLoading] = useState(false);
  const [pinError, setPinError] = useState("");
  const [dndSaving, setDndSaving] = useState(false);

  const handleDoNotDisturbToggle = async (
    _event: React.ChangeEvent<HTMLInputElement>,
    checked: boolean,
  ) => {
    onDoNotDisturbChange(checked);
    setDndSaving(true);
    const res = await updateDoNotDisturb(checked);
    setDndSaving(false);
    if (!res.ok) {
      onDoNotDisturbChange(!checked);
    }
  };

  const openPinDialog = () => {
    setPinStep("verify");
    setCurrentPin("");
    setNewPin1("");
    setPinError("");
    setPinDialogOpen(true);
  };

  const handleSaveHandle = async () => {
    if (!handle.trim() || handle === currentUser.handle) return;
    setSavingHandle(true);
    setHandleErr("");
    setHandleMsg("");
    const { res, data } = await updateMe({ handle });
    setSavingHandle(false);
    if (!res.ok) {
      setHandleErr(data.error || "保存失败");
      return;
    }
    setHandleMsg("ID 已更新");
    onUserUpdated(data.user!);
  };

  const handleSaveUsername = async () => {
    if (!username.trim() || username === currentUser.username) return;
    setSavingUsername(true);
    setUsernameErr("");
    setUsernameMsg("");
    const { res, data } = await updateMe({ username });
    setSavingUsername(false);
    if (!res.ok) {
      setUsernameErr(data.error || "保存失败");
      return;
    }
    setUsernameMsg("显示名称已更新");
    onUserUpdated(data.user!);
  };

  const submitPinReset = useCallback(
    async (curPin: string, p1: string, p2?: string) => {
      setPinLoading(true);
      setPinError("");
      const new_pins = p2 ? [p1, p2] : [p1];
      const { res, data } = await updateMe({
        resetPins: { current_pin: curPin, new_pins },
      });
      setPinLoading(false);
      if (!res.ok) {
        setPinError(data.error || "重置失败");
        setPinStep("verify");
        setCurrentPin("");
        setNewPin1("");
        return;
      }
      setPinStep("done");
    },
    [],
  );

  const handleNumPad = useCallback(
    async (pin: string) => {
      if (pinStep === "verify") {
        setCurrentPin(pin);
        setPinStep("new1");
        setPinError("");
      } else if (pinStep === "new1") {
        setNewPin1(pin);
        setPinStep("new2_prompt");
        setPinError("");
      } else if (pinStep === "new2") {
        await submitPinReset(currentPin, newPin1, pin);
      }
    },
    [pinStep, currentPin, newPin1, submitPinReset],
  );

  const pinStepContent = () => {
    switch (pinStep) {
      case "verify":
        return (
          <NumPad
            onComplete={handleNumPad}
            hint="① 输入当前 PIN 验证"
            error={pinError}
            loading={pinLoading}
          />
        );
      case "new1":
        return (
          <NumPad
            onComplete={handleNumPad}
            hint="② 输入新 PIN"
            error={pinError}
          />
        );
      case "new2_prompt":
        return (
          <Box sx={{ textAlign: "center" }}>
            <Typography variant="body2" sx={{ mb: 2 }}>
              是否设置第二个 PIN？
            </Typography>
            <Button
              variant="contained"
              sx={{ mr: 1 }}
              onClick={() => setPinStep("new2")}
            >
              添加第二个
            </Button>
            <Button
              variant="outlined"
              onClick={() => submitPinReset(currentPin, newPin1)}
            >
              只保留一个
            </Button>
          </Box>
        );
      case "new2":
        return (
          <NumPad
            onComplete={handleNumPad}
            hint="③ 输入第二个 PIN"
            error={pinError}
            loading={pinLoading}
          />
        );
      case "done":
        return (
          <Box sx={{ textAlign: "center" }}>
            <Alert severity="success" sx={{ mb: 2 }}>
              PIN 已重置成功
            </Alert>
            <Button variant="contained" onClick={() => setPinDialogOpen(false)}>
              关闭
            </Button>
          </Box>
        );
      default:
        return null;
    }
  };

  return (
    <Box sx={{ p: 3, maxWidth: 480 }}>
      <Box sx={{ display: "flex", alignItems: "center", mb: 2 }}>
        {onBack && (
          <IconButton size="small" onClick={onBack} sx={{ mr: 1 }}>
            <ArrowBackIcon fontSize="small" />
          </IconButton>
        )}
        <Typography variant="h6" sx={{ fontWeight: 600 }}>
          设置
        </Typography>
      </Box>

      {/* Appearance */}
      <Typography variant="body2" sx={{ mb: 1, fontWeight: 600 }}>
        外观
      </Typography>
      <FormControlLabel
        control={
          <Switch checked={themeMode === "dark"} onChange={onThemeToggle} />
        }
        label="深色模式"
      />

      <Divider sx={{ my: 2 }} />

      {/* Notifications */}
      <Typography variant="body2" sx={{ mb: 0.5, fontWeight: 600 }}>
        通知
      </Typography>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: "block", mb: 1 }}
      >
        开启后，所有新消息都不会弹出横幅通知（侧边栏未读仍会更新）。
      </Typography>
      <FormControlLabel
        control={
          <Switch
            checked={doNotDisturb}
            onChange={handleDoNotDisturbToggle}
            disabled={dndSaving || !online}
          />
        }
        label="请勿打扰"
      />

      <Divider sx={{ my: 2 }} />

      {/* Handle */}
      <Typography variant="body2" sx={{ mb: 0.5, fontWeight: 600 }}>
        ID（@handle）
      </Typography>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: "block", mb: 1 }}
      >
        字母、数字、下划线，最多 20 位。用于 @提及 和登录识别。
      </Typography>
      <Box sx={{ display: "flex", alignItems: "center", mb: 0.5 }}>
        <TextField
          disabled={!online}
          size="small"
          value={handle}
          onChange={(e) => {
            setHandle(e.target.value.replace(/[^a-zA-Z0-9_]/g, ""));
            setHandleErr("");
            setHandleMsg("");
          }}
          inputProps={{ maxLength: 20 }}
          sx={{ flex: 1, mr: 1 }}
          InputProps={{
            startAdornment: (
              <Typography
                variant="body2"
                sx={{ mr: 0.5, color: "text.secondary" }}
              >
                @
              </Typography>
            ),
          }}
        />
        <Button
          variant="outlined"
          size="small"
          onClick={handleSaveHandle}
          disabled={
            !online ||
            savingHandle ||
            !handle.trim() ||
            handle === currentUser.handle
          }
        >
          保存
        </Button>
      </Box>
      {handleMsg && (
        <Alert severity="success" sx={{ mb: 1, py: 0 }}>
          {handleMsg}
        </Alert>
      )}
      {handleErr && (
        <Alert severity="error" sx={{ mb: 1, py: 0 }}>
          {handleErr}
        </Alert>
      )}

      <Divider sx={{ my: 2 }} />

      {/* Display name */}
      <Typography variant="body2" sx={{ mb: 1, fontWeight: 600 }}>
        显示名称
      </Typography>
      <Box sx={{ display: "flex", alignItems: "center", mb: 0.5 }}>
        <TextField
          disabled={!online}
          size="small"
          value={username}
          onChange={(e) => {
            setUsername(e.target.value);
            setUsernameErr("");
            setUsernameMsg("");
          }}
          inputProps={{ maxLength: 30 }}
          sx={{ flex: 1, mr: 1 }}
        />
        <Button
          variant="outlined"
          size="small"
          onClick={handleSaveUsername}
          disabled={
            !online ||
            savingUsername ||
            !username.trim() ||
            username === currentUser.username
          }
        >
          保存
        </Button>
      </Box>
      {usernameMsg && (
        <Alert severity="success" sx={{ mb: 1, py: 0 }}>
          {usernameMsg}
        </Alert>
      )}
      {usernameErr && (
        <Alert severity="error" sx={{ mb: 1, py: 0 }}>
          {usernameErr}
        </Alert>
      )}

      <Divider sx={{ my: 2 }} />

      {/* PIN management */}
      <Typography variant="body2" sx={{ mb: 0.5, fontWeight: 600 }}>
        PIN 管理
      </Typography>
      <Typography
        variant="caption"
        sx={{ color: "text.secondary", display: "block", mb: 1 }}
      >
        修改 PIN 时，所有旧 PIN 将被替换。需要先验证当前任意一个 PIN。
      </Typography>
      <Button
        variant="outlined"
        size="small"
        onClick={openPinDialog}
        disabled={!online}
      >
        重置 PIN 码
      </Button>

      <Divider sx={{ my: 2 }} />

      <Button
        variant="outlined"
        color="error"
        size="small"
        onClick={onLogout}
        disabled={!online}
      >
        退出登录
      </Button>

      <Divider sx={{ my: 2 }} />

      <Button
        variant="text"
        sx={{
          color: "text.secondary",
          whiteSpace: "nowrap",
          borderRadius: 1,
          textAlign: "left",
        }}
        onClick={() => about()}
      >
        Baker - Endfield Industry
        <br />
        Powered by Protocol-Originium
      </Button>

      <div
        style={{
          position: "fixed",
          right: "-60px",
          bottom: "-60px",
          zIndex: 1,
          pointerEvents: "none",
        }}
      >
        <EndfieldLogo
          color={
            useTheme().palette.mode === "light" ? "#00000011" : "#ffffff11"
          }
          styles={{ width: "320px", height: "320px" }}
        />
      </div>

      {/* PIN reset dialog */}
      <Dialog
        open={pinDialogOpen}
        onClose={() => !pinLoading && setPinDialogOpen(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>重置 PIN 码</DialogTitle>
        <DialogContent sx={{ pb: 3 }}>
          {pinLoading &&
          pinStep !== "verify" &&
          pinStep !== "new1" &&
          pinStep !== "new2" ? (
            <Box sx={{ textAlign: "center", py: 3 }}>
              <CircularProgress />
            </Box>
          ) : (
            pinStepContent()
          )}
        </DialogContent>
      </Dialog>
    </Box>
  );
}
