import type { CSSProperties, ReactNode } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Fade from "@mui/material/Fade";
import Typography from "@mui/material/Typography";
import type { SxProps, Theme } from "@mui/material/styles";
import { flexGap } from "@/client/lib/css";

import {
  Infini2List,
  type Infini2Controller,
  type Infini2DomHost,
  type Infini2Id,
  type Infini2Snapshot,
} from "@/lib/infini2";

interface Infini2ViewProps<TItem, TCursor, TId extends Infini2Id, TTarget> {
  controller: Infini2Controller<TItem, TCursor, TId, TTarget>;
  snapshot: Infini2Snapshot<TItem, TId>;
  renderItem: (item: TItem, id: TId) => ReactNode;
  beforeLabel: string;
  afterLabel: string;
  onRetry: () => void;
  empty?: ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
  className?: string;
  rootSx?: SxProps<Theme>;
  surfaceClassName?: string;
  surfaceStyle?: CSSProperties;
  rowClassName?: string;
  scrollHost?: Window | HTMLElement;
  paddingStart?: number;
  paddingEnd?: number;
  layoutBefore?: number;
  layoutAfter?: number;
  anchorRatio?: number;
  onHostChange?: (
    host: Infini2DomHost<TItem, TCursor, TId, TTarget> | null,
  ) => void;
}

function DirectionalStatus({
  edge,
  label,
  failed,
  onRetry,
}: {
  edge: "top" | "bottom";
  label: string;
  failed: boolean;
  onRetry: () => void;
}) {
  return (
    <Box
      sx={{
        position: "absolute",
        [edge]: 0,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        ...flexGap(1),
        bgcolor: "background.paper",
        border: "1px solid",
        borderColor: "divider",
        borderRadius: 999,
        px: 1.5,
        py: 0.5,
        boxShadow: 2,
      }}
    >
      {failed ? (
        <Button size="small" color="error" onClick={onRetry}>
          {label}失败，重试
        </Button>
      ) : (
        <>
          <CircularProgress size={16} />
          <Typography variant="caption" color="text.secondary">
            {label}
          </Typography>
        </>
      )}
    </Box>
  );
}

/** Shared visual shell for Infini2-backed application lists. */
export default function Infini2View<
  TItem,
  TCursor,
  TId extends Infini2Id,
  TTarget,
>({
  controller,
  snapshot,
  renderItem,
  beforeLabel,
  afterLabel,
  onRetry,
  empty,
  header,
  footer,
  className,
  rootSx,
  surfaceClassName,
  surfaceStyle,
  rowClassName,
  scrollHost,
  paddingStart,
  paddingEnd,
  layoutBefore,
  layoutAfter,
  anchorRatio,
  onHostChange,
}: Infini2ViewProps<TItem, TCursor, TId, TTarget>) {
  const phase = snapshot.phase;
  const hasItems = snapshot.mainLength > 0;
  const isBootstrapping =
    phase.status === "dormant" ||
    (phase.status === "bootstrapping" && !hasItems);
  const bootstrapFailed =
    phase.status === "failed" && phase.operation === "bootstrap" && !hasItems;
  const failedDirection =
    phase.status === "failed" &&
    (phase.operation === "fetch" || phase.operation === "seek")
      ? phase.direction
      : null;

  return (
    <Box className={className} sx={rootSx}>
      <Fade in={isBootstrapping || bootstrapFailed} unmountOnExit>
        <Box
          sx={{
            position: "absolute",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 40,
            pointerEvents: bootstrapFailed ? "auto" : "none",
          }}
        >
          {bootstrapFailed ? (
            <Button variant="contained" color="error" onClick={onRetry}>
              加载失败，重试
            </Button>
          ) : (
            <CircularProgress size={28} />
          )}
        </Box>
      </Fade>

      {snapshot.loadingBefore || failedDirection === "before" ? (
        <DirectionalStatus
          edge="top"
          label={beforeLabel}
          failed={failedDirection === "before"}
          onRetry={onRetry}
        />
      ) : null}
      {snapshot.loadingAfter || failedDirection === "after" ? (
        <DirectionalStatus
          edge="bottom"
          label={afterLabel}
          failed={failedDirection === "after"}
          onRetry={onRetry}
        />
      ) : null}

      <Box>
        {header}
        {!hasItems && phase.status === "ready" ? empty : null}
        <Infini2List
          controller={controller}
          renderItem={renderItem}
          scrollHost={scrollHost}
          paddingStart={paddingStart}
          paddingEnd={paddingEnd}
          layoutBefore={layoutBefore}
          layoutAfter={layoutAfter}
          anchorRatio={anchorRatio}
          className={surfaceClassName}
          style={surfaceStyle}
          rowClassName={rowClassName}
          onHostChange={onHostChange}
        />
        {footer}
      </Box>
    </Box>
  );
}
