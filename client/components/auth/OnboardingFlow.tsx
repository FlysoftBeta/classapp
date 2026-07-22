import React from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import TextField from "@mui/material/TextField";
import Alert from "@mui/material/Alert";
import CircularProgress from "@mui/material/CircularProgress";
import NumPad from "@/client/components/shared/NumPad";
import AuthScreen from "./AuthScreen";
import type { OobeState } from "@/client/hooks/useAppLogic";

interface OnboardingFlowProps {
  oobe: OobeState;
  oobeHandle: string;
  setOobeHandle: (v: string) => void;
  oobeUsername: string;
  setOobeUsername: (v: string) => void;
  onPin: (pin: string) => void;
  onSubmit: () => void;
  onStepChange: (step: OobeState["step"]) => void;
  clientId: string;
}

export default function OnboardingFlow({
  oobe,
  oobeHandle,
  setOobeHandle,
  oobeUsername,
  setOobeUsername,
  onPin,
  onSubmit,
  onStepChange,
  clientId,
}: OnboardingFlowProps) {
  const renderStep = () => {
    switch (oobe.step) {
      case "pin1":
        return (
          <NumPad onComplete={onPin} hint="① 设置 PIN 码" error={oobe.error} />
        );

      case "pin2_prompt":
        return (
          <Box sx={{ textAlign: "center" }}>
            <Typography variant="body2" sx={{ mb: 3 }}>
              是否添加第二个备用 PIN？（最多 2 个）
            </Typography>
            <Button
              variant="contained"
              sx={{ mr: 1 }}
              onClick={() => onStepChange("pin2")}
            >
              添加第二个
            </Button>
            <Button variant="outlined" onClick={() => onStepChange("handle")}>
              跳过
            </Button>
          </Box>
        );

      case "pin2":
        return (
          <NumPad
            onComplete={onPin}
            hint="② 输入第二个备用 PIN"
            error={oobe.error}
          />
        );

      case "handle":
        return (
          <Box sx={{ textAlign: "center" }}>
            <Typography variant="body2" sx={{ mb: 0.5 }}>
              {oobe.pin2 ? "③" : "②"} 设置 ID（@handle）
            </Typography>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: "block", mb: 2 }}
            >
              字母、数字、下划线，最多 20 位。
            </Typography>
            <TextField
              autoFocus
              size="small"
              value={oobeHandle}
              onChange={(e) =>
                setOobeHandle(e.target.value.replace(/[^a-zA-Z0-9_]/g, ""))
              }
              placeholder="your_handle"
              inputProps={{ maxLength: 20 }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && oobeHandle.trim())
                  onStepChange("username");
              }}
              sx={{ mb: 2, width: 240 }}
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
            {oobe.error && (
              <Alert severity="error" sx={{ mb: 2 }}>
                {oobe.error}
              </Alert>
            )}
            <Box>
              <Button
                variant="contained"
                disabled={!oobeHandle.trim()}
                onClick={() => onStepChange("username")}
              >
                下一步
              </Button>
            </Box>
          </Box>
        );

      case "username":
        return (
          <Box sx={{ textAlign: "center" }}>
            <Typography variant="body2" sx={{ mb: 0.5 }}>
              {oobe.pin2 ? "④" : "③"} 设置显示名称
            </Typography>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ display: "block", mb: 2 }}
            >
              可以是任意字符，最多 30 位。
            </Typography>
            <TextField
              autoFocus
              size="small"
              value={oobeUsername}
              onChange={(e) => setOobeUsername(e.target.value)}
              placeholder="你的名字"
              inputProps={{ maxLength: 30 }}
              onKeyDown={(e) => {
                if (e.key === "Enter") onSubmit();
              }}
              sx={{ mb: 2, width: 240 }}
            />
            {oobe.error && (
              <Alert severity="error" sx={{ mb: 2 }}>
                {oobe.error}
              </Alert>
            )}
            <Box>
              <Button
                variant="contained"
                onClick={onSubmit}
                disabled={oobe.submitting || !oobeUsername.trim()}
              >
                {oobe.submitting ? <CircularProgress size={18} /> : "完成"}
              </Button>
            </Box>
          </Box>
        );
    }
  };

  return (
    <AuthScreen
      title="初始设置"
      description="完成账号信息设置后即可进入应用。"
      clientId={clientId}
    >
      <Box sx={{ width: "100%" }}>{renderStep()}</Box>
    </AuthScreen>
  );
}
