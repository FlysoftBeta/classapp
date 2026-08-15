import type { ReactNode } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import CircularProgress from "@mui/material/CircularProgress";
import FormControlLabel from "@mui/material/FormControlLabel";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import {
  FEATURES,
  FEATURE_LABELS,
  type Feature,
  type UserFeatures,
} from "@/shared/features";
import { flexGap } from "@/client/lib/css";

export type FeatureGateChange = "unchanged" | "enabled" | "disabled";
export type FeatureGateChanges = Record<Feature, FeatureGateChange>;
export type FeatureGateAggregateState = "enabled" | "mixed" | "disabled";
export type FeatureGateAggregateStates = Record<
  Feature,
  FeatureGateAggregateState
>;

export function createUnchangedFeatureGateChanges(): FeatureGateChanges {
  return Object.fromEntries(
    FEATURES.map((feature) => [feature, "unchanged"]),
  ) as FeatureGateChanges;
}

export function featureGateChangesFromFeatures(
  features: UserFeatures,
): FeatureGateChanges {
  return Object.fromEntries(
    FEATURES.map((feature) => [
      feature,
      features[feature] ? "enabled" : "disabled",
    ]),
  ) as FeatureGateChanges;
}

export function aggregateFeatureGateStates(
  users: Array<{ features: UserFeatures }>,
): FeatureGateAggregateStates {
  return Object.fromEntries(
    FEATURES.map((feature) => {
      const enabledCount = users.filter(
        (user) => user.features[feature],
      ).length;
      const state: FeatureGateAggregateState =
        enabledCount === 0
          ? "disabled"
          : enabledCount === users.length
            ? "enabled"
            : "mixed";
      return [feature, state];
    }),
  ) as FeatureGateAggregateStates;
}

export function applyFeatureGateChanges(
  features: UserFeatures,
  changes: FeatureGateChanges,
): UserFeatures {
  return Object.fromEntries(
    FEATURES.map((feature) => {
      const change = changes[feature];
      return [
        feature,
        change === "unchanged" ? features[feature] : change === "enabled",
      ];
    }),
  ) as UserFeatures;
}

interface FeatureGatesPanelProps {
  value: FeatureGateChanges;
  aggregateValue?: FeatureGateAggregateStates;
  onChange: (feature: Feature, change: FeatureGateChange) => void;
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
        {FEATURES.map((feature) => {
          const aggregateState =
            value[feature] === "unchanged"
              ? (aggregateValue?.[feature] ?? "mixed")
              : value[feature];
          const stateLabel = allowUnchanged
            ? STATE_LABELS[aggregateState]
            : aggregateState === "enabled"
              ? "启用"
              : "禁用";
          return (
            <Box
              key={feature}
              sx={{
                px: 1,
                py: 0.25,
                bgcolor: "background.paper",
              }}
            >
              <FormControlLabel
                sx={{ m: 0, width: "100%" }}
                label={FEATURE_LABELS[feature]}
                control={
                  <Checkbox
                    size="small"
                    checked={aggregateState === "enabled"}
                    indeterminate={allowUnchanged && aggregateState === "mixed"}
                    disabled={disabled || applying}
                    inputProps={{
                      "aria-label": `${FEATURE_LABELS[feature]}：${stateLabel}`,
                    }}
                    onChange={(_, checked) =>
                      onChange(feature, checked ? "enabled" : "disabled")
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
