import { parseDbTime } from "@/shared/time";

/** Parse server timestamps without an explicit offset as UTC. */
export function parseServerTime(value: string): Date {
  return parseDbTime(value);
}

function formatServerTime(
  value: string,
  options: Intl.DateTimeFormatOptions,
): string {
  const date = parseServerTime(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", options).format(date);
}

/** Display a server timestamp in the device's current time zone. */
export function formatDeviceDateTime(
  value: string,
  includeSeconds = false,
): string {
  return formatServerTime(value, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    ...(includeSeconds ? { second: "2-digit" } : {}),
    hourCycle: "h23",
  });
}

/** Display a server timestamp as a calendar date in the device's time zone. */
export function formatDeviceDate(value: string): string {
  return formatServerTime(value, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}
