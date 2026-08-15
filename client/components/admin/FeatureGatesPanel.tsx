import Box from "@mui/material/Box";
import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import Typography from "@mui/material/Typography";
import {
  FEATURES,
  FEATURE_LABELS,
  type Feature,
  type UserFeatures,
} from "@/shared/features";
import { IncrementalCheckbox } from "./IncrementalField";

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
  description?: string;
  disabled?: boolean;
}

export function FeatureGatesPanel({
  value,
  aggregateValue,
  onChange,
  allowUnchanged = true,
  description,
  disabled = false,
}: FeatureGatesPanelProps) {
  return (
    <Box sx={{ pt: 0.5 }}>
      {description ? (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          {description}
        </Typography>
      ) : null}

      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
          columnGap: 1,
        }}
      >
        {FEATURES.map((feature) => {
          const aggregateState =
            value[feature] === "unchanged"
              ? (aggregateValue?.[feature] ?? "mixed")
              : value[feature];
          return (
            <Box
              key={feature}
              sx={{
                minWidth: 0,
              }}
            >
              {allowUnchanged ? (
                <IncrementalCheckbox
                  label={FEATURE_LABELS[feature]}
                  value={value[feature]}
                  aggregate={aggregateValue?.[feature] ?? "mixed"}
                  disabled={disabled}
                  onChange={(change) => onChange(feature, change)}
                />
              ) : (
                <FormControlLabel
                  sx={{ m: 0, width: "100%" }}
                  label={FEATURE_LABELS[feature]}
                  control={
                    <Checkbox
                      size="small"
                      checked={aggregateState === "enabled"}
                      disabled={disabled}
                      onChange={(_, checked) =>
                        onChange(feature, checked ? "enabled" : "disabled")
                      }
                    />
                  }
                />
              )}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
