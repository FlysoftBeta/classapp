import type { ReactNode } from "react";
import Box from "@mui/material/Box";
import FormControlLabel from "@mui/material/FormControlLabel";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import type { AiCreditBalance } from "@/shared/types/api";
import { MultiSectionDurationPicker } from "./MultiSectionDurationPicker";
import {
  IncrementalCheckbox,
  type IncrementalBoolean,
} from "./IncrementalField";

export function AiCreditsFields({
  balance,
  targetDescription,
  planDays,
  amount,
  note,
  onPlanDaysChange,
  onAmountChange,
  onNoteChange,
}: {
  balance?: AiCreditBalance | null;
  targetDescription: ReactNode;
  planDays: string;
  amount: string;
  note: string;
  onPlanDaysChange: (value: string) => void;
  onAmountChange: (value: string) => void;
  onNoteChange: (value: string) => void;
}) {
  return (
    <Box sx={{ display: "grid", gap: 1.5, pt: 0.5 }}>
      <Typography variant="body2" color="text.secondary">
        {targetDescription}
      </Typography>
      {balance !== undefined ? (
        <Box>
          <Typography variant="subtitle2">当前额度</Typography>
          <Typography variant="caption" color="text.secondary">
            日额度已用 {balance?.plan.daily.used_percent ?? "…"}% · 周额度已用{" "}
            {balance?.plan.weekly.used_percent ?? "…"}% · 额外{" "}
            {balance?.top_up ?? "…"} credits
          </Typography>
        </Box>
      ) : null}
      <TextField
        label="套餐天数（留空不分配）"
        size="small"
        fullWidth
        inputMode="numeric"
        value={planDays}
        onChange={(event) =>
          onPlanDaysChange(event.target.value.replace(/\D/g, ""))
        }
      />
      <TextField
        label="充值数量（留空不充值）"
        size="small"
        fullWidth
        inputMode="numeric"
        value={amount}
        onChange={(event) =>
          onAmountChange(event.target.value.replace(/\D/g, ""))
        }
      />
      <TextField
        label="充值备注"
        size="small"
        fullWidth
        value={note}
        onChange={(event) => onNoteChange(event.target.value.slice(0, 200))}
      />
    </Box>
  );
}

type AggregateState = "enabled" | "disabled" | "mixed";

type RestrictionFieldsProps =
  | {
      mode: "single";
      muted: boolean;
      banned: boolean;
      onMutedChange: (value: boolean) => void;
      onBannedChange: (value: boolean) => void;
      muteDuration?: DurationProps;
      banDuration?: DurationProps;
    }
  | {
      mode: "batch";
      mute: IncrementalBoolean;
      ban: IncrementalBoolean;
      muteAggregate: AggregateState;
      banAggregate: AggregateState;
      onMuteChange: (value: IncrementalBoolean) => void;
      onBanChange: (value: IncrementalBoolean) => void;
      duration?: DurationProps;
    };

interface DurationProps {
  days: number;
  hours: number;
  onDaysChange: (value: number) => void;
  onHoursChange: (value: number) => void;
}

function DurationField({
  label,
  value,
}: {
  label: string;
  value: DurationProps;
}) {
  return (
    <Box sx={{ pl: 4, mb: 1 }}>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <MultiSectionDurationPicker
        days={value.days}
        hours={value.hours}
        onDaysChange={value.onDaysChange}
        onHoursChange={value.onHoursChange}
      />
    </Box>
  );
}

export function RestrictionFields(props: RestrictionFieldsProps) {
  if (props.mode === "single") {
    return (
      <Box sx={{ display: "grid", pt: 0.5 }}>
        <FormControlLabel
          control={
            <Switch
              checked={props.muted}
              onChange={(_, value) => props.onMutedChange(value)}
            />
          }
          label="禁言"
        />
        {props.muteDuration ? (
          <DurationField label="禁言时长" value={props.muteDuration} />
        ) : null}
        <FormControlLabel
          control={
            <Switch
              checked={props.banned}
              onChange={(_, value) => props.onBannedChange(value)}
            />
          }
          label="封禁并撤销会话"
        />
        {props.banDuration ? (
          <DurationField label="封禁时长" value={props.banDuration} />
        ) : null}
      </Box>
    );
  }

  return (
    <Box sx={{ display: "grid", pt: 0.5 }}>
      <IncrementalCheckbox
        label="禁言"
        value={props.mute}
        aggregate={props.muteAggregate}
        onChange={props.onMuteChange}
      />
      <IncrementalCheckbox
        label="封禁并撤销会话"
        value={props.ban}
        aggregate={props.banAggregate}
        onChange={props.onBanChange}
      />
      {props.duration ? (
        <DurationField label="新限制的持续时间" value={props.duration} />
      ) : null}
    </Box>
  );
}
