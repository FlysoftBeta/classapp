import React, { useRef, useCallback, useEffect } from "react";
import Box from "@mui/material/Box";
import { inset } from "@/client/lib/css";

// Konami-style unlock sequence: U U D D L R L R.
// Tap zones map screen edges; deliberately invisible to match the existing
// covert-keypad UX.
const UNLOCK_SEQUENCE = ["U", "U", "D", "D", "L", "R", "L", "R"] as const;
type Zone = "U" | "D" | "L" | "R";

function getTapZone(x: number, y: number, w: number, h: number): Zone | null {
  const relX = x / w;
  const relY = y / h;
  if (relY < 0.33) return "U";
  if (relY > 0.67) return "D";
  if (relX < 0.33) return "L";
  if (relX > 0.67) return "R";
  return null;
}

interface LockScreenProps {
  onUnlock: () => Promise<string | null>;
}

export default function LockScreen({ onUnlock }: LockScreenProps) {
  const progressRef = useRef(0);
  const ignoreMouseUntilRef = useRef(0);
  const checkingRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const handleZone = useCallback(
    (zone: Zone | null) => {
      if (!zone) {
        progressRef.current = 0;
        return;
      }
      const expected = UNLOCK_SEQUENCE[progressRef.current];
      if (zone === expected) {
        const next = progressRef.current + 1;
        progressRef.current = next;
        if (next >= UNLOCK_SEQUENCE.length && !checkingRef.current) {
          progressRef.current = 0;
          checkingRef.current = true;
          void onUnlock().finally(() => {
            checkingRef.current = false;
          });
        }
      } else {
        progressRef.current = 0;
      }
    },
    [onUnlock],
  );

  const handleTap = useCallback(
    (clientX: number, clientY: number) => {
      handleZone(
        getTapZone(clientX, clientY, window.innerWidth, window.innerHeight),
      );
    },
    [handleZone],
  );

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      const touch = e.changedTouches[0];
      if (!touch) return;
      ignoreMouseUntilRef.current = Date.now() + 700;
      handleTap(touch.clientX, touch.clientY);
    },
    [handleTap],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (Date.now() < ignoreMouseUntilRef.current) return;
      handleTap(e.clientX, e.clientY);
    },
    [handleTap],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const keyZones: Record<string, Zone | undefined> = {
        ArrowUp: "U",
        w: "U",
        W: "U",
        ArrowDown: "D",
        s: "D",
        S: "D",
        ArrowLeft: "L",
        a: "L",
        A: "L",
        ArrowRight: "R",
        d: "R",
        D: "R",
      };
      const zone = keyZones[e.key];
      if (!zone) return;
      e.preventDefault();
      handleZone(zone);
    },
    [handleZone],
  );

  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  return (
    <Box
      ref={rootRef}
      tabIndex={0}
      role="application"
      aria-label="锁定屏幕"
      sx={{
        position: "fixed",
        bgcolor: "background.default",
        touchAction: "none",
        outline: "none",
        ...inset(0),
      }}
      onTouchStart={handleTouchStart}
      onMouseDown={handleMouseDown}
      onKeyDown={handleKeyDown}
    />
  );
}
