/**
 * NumPad — human-friendly PIN entry with visible numbers and digit indicators.
 * Used in OOBE, Settings PIN reset, and any authenticated PIN flow.
 */
import React, { useState, useCallback, useEffect, useRef } from "react";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Typography from "@mui/material/Typography";
import CircularProgress from "@mui/material/CircularProgress";
import BackspaceOutlinedIcon from "@mui/icons-material/BackspaceOutlined";

// 3×4 grid layout
const KEYS: (number | null | "del")[] = [
  1,
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  null,
  0,
  "del",
];

interface NumPadProps {
  onComplete: (pin: string) => void;
  loading?: boolean;
  loadingLabel?: string;
  error?: string;
  hint?: string;
}

export default function NumPad({
  onComplete,
  loading,
  loadingLabel = "正在处理…",
  error,
  hint,
}: NumPadProps) {
  const [pin, setPin] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  const handleKey = useCallback(
    (key: number | null | "del") => {
      if (loading || key === null) return;
      if (key === "del") {
        setPin((p) => p.slice(0, -1));
        return;
      }

      const next = pin + key.toString();
      setPin(next);
      if (next.length === 6) {
        onComplete(next);
        setPin("");
      }
    },
    [pin, loading, onComplete],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key >= "0" && event.key <= "9") {
        event.preventDefault();
        handleKey(Number(event.key));
        return;
      }

      if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        handleKey("del");
      }
    },
    [handleKey],
  );

  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  return (
    <Box
      ref={rootRef}
      tabIndex={0}
      role="group"
      aria-label="六位 PIN 数字键盘"
      aria-busy={loading || undefined}
      onKeyDown={handleKeyDown}
      sx={{ textAlign: "center", userSelect: "none", outline: "none" }}
    >
      {loading ? (
        <Box
          role="status"
          aria-live="polite"
          sx={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 1.25,
            borderRadius: 3,
            bgcolor: "background.default",
            opacity: 0.96,
          }}
        >
          <CircularProgress size={28} />
          <Typography variant="body2" color="text.secondary">
            {loadingLabel}
          </Typography>
        </Box>
      ) : (
        <>
          {hint && (
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              {hint}
            </Typography>
          )}

          {/* Digit count dots */}
          <Box sx={{ display: "flex", justifyContent: "center", mb: 2 }}>
            {Array(6)
              .fill(null)
              .map((_, i) => (
                <Box
                  key={i}
                  sx={{
                    width: 12,
                    height: 12,
                    borderRadius: "50%",
                    mx: 0.75,
                    bgcolor:
                      i < pin.length ? "primary.main" : "action.disabled",
                    transition: "background-color 0.12s",
                  }}
                />
              ))}
          </Box>

          {error && (
            <Typography
              role="alert"
              aria-live="polite"
              variant="caption"
              color="error"
              sx={{ display: "block", mb: 1.5 }}
            >
              {error}
            </Typography>
          )}

          {/* 3×4 keypad */}
          <Box
            sx={{
              position: "relative",
              display: "grid",
              gridTemplateColumns: "repeat(3, 72px)",
              gridTemplateRows: "repeat(4, 72px)",
              justifyContent: "center",
            }}
          >
            {KEYS.map((key, i) => {
              if (key === null) return <Box key={i} />;

              return (
                <Box
                  key={i}
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <ButtonBase
                    onClick={() => handleKey(key)}
                    disabled={loading}
                    sx={{
                      width: 64,
                      height: 64,
                      borderRadius: "50%",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      justifyContent: "center",
                      bgcolor: "action.hover",
                      border: "1px solid",
                      borderColor: "divider",
                      transition: "background-color 0.1s",
                      "&:hover": { bgcolor: "action.selected" },
                      "&:disabled": { opacity: 0.4 },
                    }}
                    aria-label={key === "del" ? "退格" : String(key)}
                  >
                    {key === "del" ? (
                      <BackspaceOutlinedIcon
                        sx={{ fontSize: 20, color: "text.secondary" }}
                      />
                    ) : (
                      <Typography
                        variant="h6"
                        sx={{ fontWeight: 400, lineHeight: 1 }}
                      >
                        {key}
                      </Typography>
                    )}
                  </ButtonBase>
                </Box>
              );
            })}
          </Box>
        </>
      )}
    </Box>
  );
}
