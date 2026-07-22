import React from "react";
import NumPad from "@/client/components/shared/NumPad";
import AuthScreen from "./AuthScreen";

interface LoginScreenProps {
  onComplete: (pin: string) => void;
  loading?: boolean;
  error?: string;
  clientId: string;
}

export default function LoginScreen({
  onComplete,
  loading,
  error,
  clientId,
}: LoginScreenProps) {
  return (
    <AuthScreen
      title="登录"
      description="请输入 6 位 PIN 以继续。"
      clientId={clientId}
    >
      <NumPad
        onComplete={onComplete}
        loading={loading}
        loadingLabel="正在登录…"
        error={error}
      />
    </AuthScreen>
  );
}
