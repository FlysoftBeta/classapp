import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import type { ReactNode } from "react";

export type IncrementalBoolean = "unchanged" | "enabled" | "disabled";

export const BATCH_INCREMENTAL_HELP =
  "勾选表示全部选择，半选表示存在不一致的选择，不选表示全部不选择。不变动的字段不会应用。";

/** Shows the aggregate state until the administrator makes an explicit change. */
export function IncrementalCheckbox({
  label,
  value,
  aggregate,
  onChange,
  disabled = false,
}: {
  label: ReactNode;
  value: IncrementalBoolean;
  aggregate: "enabled" | "disabled" | "mixed";
  onChange: (value: IncrementalBoolean) => void;
  disabled?: boolean;
}) {
  const visual = value === "unchanged" ? aggregate : value;
  return (
    <FormControlLabel
      control={
        <Checkbox
          size="small"
          checked={visual === "enabled"}
          indeterminate={value === "unchanged" && aggregate === "mixed"}
          disabled={disabled}
          onClick={(event) => {
            event.preventDefault();
            onChange(
              value === "unchanged"
                ? aggregate === "enabled"
                  ? "disabled"
                  : "enabled"
                : value === "enabled"
                  ? "disabled"
                  : "enabled",
            );
          }}
        />
      }
      label={label}
    />
  );
}
