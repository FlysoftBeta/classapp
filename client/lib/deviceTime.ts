const EXPLICIT_TIME_ZONE = /(?:z|[+-]\d{2}:?\d{2})$/i;

/** Parse server timestamps without an explicit offset as UTC. */
export function parseServerTime(value: string): Date {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return new Date(`${trimmed}T00:00:00Z`);
  }

  const isoValue = trimmed.replace(" ", "T");
  return new Date(
    EXPLICIT_TIME_ZONE.test(isoValue) ? isoValue : `${isoValue}Z`,
  );
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
