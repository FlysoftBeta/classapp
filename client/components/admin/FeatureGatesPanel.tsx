import type { ReactNode } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import CircularProgress from "@mui/material/CircularProgress";
import FormControlLabel from "@mui/material/FormControlLabel";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import {
  FEATURE_GATES,
  FEATURE_GATE_LABELS,
  hasFeature,
  setFeature,
  type FeatureGate,
} from "@/shared/features";
import { flexGap } from "@/client/lib/css";

export type FeatureGateChange = "unchanged" | "enabled" | "disabled";
export type FeatureGateChanges = Record<FeatureGate, FeatureGateChange>;
export type FeatureGateAggregateState = "enabled" | "mixed" | "disabled";
export type FeatureGateAggregateStates = Record<
  FeatureGate,
  FeatureGateAggregateState
>;

export function createUnchangedFeatureGateChanges(): FeatureGateChanges {
  return Object.fromEntries(
    FEATURE_GATES.map((gate) => [gate, "unchanged"]),
  ) as FeatureGateChanges;
}

export function featureGateChangesFromMask(
  featureMask: number,
): FeatureGateChanges {
  return Object.fromEntries(
    FEATURE_GATES.map((gate) => [
      gate,
      hasFeature({ feature_mask: featureMask }, gate) ? "enabled" : "disabled",
    ]),
  ) as FeatureGateChanges;
}

export function aggregateFeatureGateStates(
  users: Array<{ feature_mask: number }>,
): FeatureGateAggregateStates {
  return Object.fromEntries(
    FEATURE_GATES.map((gate) => {
      const enabledCount = users.filter((user) =>
        hasFeature(user, gate),
      ).length;
      const state: FeatureGateAggregateState =
        enabledCount === 0
          ? "disabled"
          : enabledCount === users.length
            ? "enabled"
            : "mixed";
      return [gate, state];
    }),
  ) as FeatureGateAggregateStates;
}

export function applyFeatureGateChanges(
  featureMask: number,
  changes: FeatureGateChanges,
): number {
  return FEATURE_GATES.reduce((mask, gate) => {
    const change = changes[gate];
    return change === "unchanged"
      ? mask
      : setFeature(mask, gate, change === "enabled");
  }, featureMask);
}

interface FeatureGatesPanelProps {
  value: FeatureGateChanges;
  aggregateValue?: FeatureGateAggregateStates;
  onChange: (gate: FeatureGate, change: FeatureGateChange) => void;
  allowUnchanged?: boolean;
  title?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  applying?: boolean;
  onApply?: () => void;
  applyDisabled?: boolean;
  applyLabel?: ReactNode;
  error?: ReactNode;
  embedded?: boolean;
}

const STATE_LABELS: Record<FeatureGateAggregateState, string> = {
  enabled: "全部启用",
  mixed: "部分启用",
  disabled: "全部禁用",
};

export function FeatureGatesPanel({
  value,
  aggregateValue,
  onChange,
  allowUnchanged = true,
  title = "功能权限",
  description,
  disabled = false,
  applying = false,
  onApply,
  applyDisabled = false,
  applyLabel = "应用",
  error,
  embedded = false,
}: FeatureGatesPanelProps) {
  return (
    <Paper
      variant="outlined"
      sx={{
        mt: embedded ? 0 : 1.5,
        overflow: "hidden",
        ...(embedded && { border: 0, borderRadius: 0 }),
      }}
    >
      <Box sx={{ px: 1.5, py: 1.25, bgcolor: "action.hover" }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
          {title}
        </Typography>
        {description ? (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: "block", mt: 0.25 }}
          >
            {description}
          </Typography>
        ) : null}
      </Box>

      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: "1px",
          bgcolor: "divider",
        }}
      >
        {FEATURE_GATES.map((gate) => {
          const aggregateState =
            value[gate] === "unchanged"
              ? (aggregateValue?.[gate] ?? "mixed")
              : value[gate];
          const stateLabel = allowUnchanged
            ? STATE_LABELS[aggregateState]
            : aggregateState === "enabled"
              ? "启用"
              : "禁用";
          return (
            <Box
              key={gate}
              sx={{
                px: 1,
                py: 0.25,
                bgcolor: "background.paper",
              }}
            >
              <FormControlLabel
                sx={{ m: 0, width: "100%" }}
                label={FEATURE_GATE_LABELS[gate]}
                control={
                  <Checkbox
                    size="small"
                    checked={aggregateState === "enabled"}
                    indeterminate={allowUnchanged && aggregateState === "mixed"}
                    disabled={disabled || applying}
                    inputProps={{
                      "aria-label": `${FEATURE_GATE_LABELS[gate]}：${stateLabel}`,
                    }}
                    onChange={(_, checked) =>
                      onChange(gate, checked ? "enabled" : "disabled")
                    }
                  />
                }
              />
            </Box>
          );
        })}
      </Box>

      {onApply ? (
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            ...flexGap(1),
            px: 1.5,
            py: 1,
            borderTop: "1px solid",
            borderColor: "divider",
          }}
        >
          <Typography variant="caption" color="error" sx={{ flex: 1 }}>
            {error}
          </Typography>
          <Button
            size="small"
            variant="contained"
            disabled={disabled || applying || applyDisabled}
            onClick={onApply}
          >
            {applying ? (
              <CircularProgress size={16} color="inherit" />
            ) : (
              applyLabel
            )}
          </Button>
        </Box>
      ) : null}
    </Paper>
  );
}
