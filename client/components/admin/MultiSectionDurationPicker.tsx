import { useLayoutEffect, useRef } from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";

const ITEM_HEIGHT = 40;
const VISIBLE_ITEMS = 5;

function PickerSection({
  label,
  value,
  max,
  onChange,
}: {
  label: string;
  value: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const initialValue = useRef(value);

  useLayoutEffect(() => {
    ref.current?.scrollTo({ top: initialValue.current * ITEM_HEIGHT });
  }, []);

  return (
    <Box sx={{ flex: 1, minWidth: 0 }}>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: "block", mb: 0.5, textAlign: "center" }}
      >
        {label}
      </Typography>
      <Box
        sx={{
          position: "relative",
          border: 1,
          borderColor: "divider",
          borderRadius: 2,
          overflow: "hidden",
          "&::before": {
            content: '""',
            position: "absolute",
            zIndex: 1,
            pointerEvents: "none",
            top: ITEM_HEIGHT * 2,
            right: 8,
            bottom: ITEM_HEIGHT * 2,
            left: 8,
            borderTop: 1,
            borderBottom: 1,
            borderColor: "primary.main",
            bgcolor: "action.selected",
          },
        }}
      >
        <Box
          ref={ref}
          role="listbox"
          aria-label={label}
          onScroll={(event) => {
            const next = Math.max(
              0,
              Math.min(
                max,
                Math.round(event.currentTarget.scrollTop / ITEM_HEIGHT),
              ),
            );
            if (next !== value) onChange(next);
          }}
          sx={{
            height: ITEM_HEIGHT * VISIBLE_ITEMS,
            overflowY: "auto",
            overscrollBehavior: "contain",
            scrollSnapType: "y mandatory",
            scrollbarWidth: "none",
            "&::-webkit-scrollbar": { display: "none" },
          }}
        >
          <Box sx={{ height: ITEM_HEIGHT * 2 }} />
          {Array.from({ length: max + 1 }, (_, option) => (
            <Box
              key={option}
              component="button"
              type="button"
              role="option"
              aria-selected={option === value}
              onClick={() => {
                ref.current?.scrollTo({
                  top: option * ITEM_HEIGHT,
                  behavior: "smooth",
                });
                onChange(option);
              }}
              sx={{
                position: "relative",
                zIndex: 2,
                display: "block",
                width: "100%",
                height: ITEM_HEIGHT,
                p: 0,
                border: 0,
                bgcolor: "transparent",
                color: option === value ? "primary.main" : "text.secondary",
                font: "inherit",
                fontSize: option === value ? 18 : 15,
                fontWeight: option === value ? 600 : 400,
                cursor: "pointer",
                scrollSnapAlign: "center",
              }}
            >
              {option}
            </Box>
          ))}
          <Box sx={{ height: ITEM_HEIGHT * 2 }} />
        </Box>
      </Box>
    </Box>
  );
}

export function MultiSectionDurationPicker({
  days,
  hours,
  onDaysChange,
  onHoursChange,
}: {
  days: number;
  hours: number;
  onDaysChange: (days: number) => void;
  onHoursChange: (hours: number) => void;
}) {
  return (
    <Box sx={{ display: "flex", gap: 1.5, maxWidth: 260, mx: "auto" }}>
      <PickerSection label="天" value={days} max={30} onChange={onDaysChange} />
      <PickerSection
        label="小时"
        value={hours}
        max={23}
        onChange={onHoursChange}
      />
    </Box>
  );
}
