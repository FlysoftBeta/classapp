export interface PaginationParams {
  limit: number;
  offset: number;
}

export function parseLimit(
  raw: string | null | undefined,
  defaultVal = 30,
  max = 200,
): number {
  const n = parseInt(raw ?? String(defaultVal), 10);
  if (!Number.isFinite(n) || n < 1) return defaultVal;
  return Math.min(n, max);
}

export function parseOffset(raw: string | null | undefined): number {
  const n = parseInt(raw ?? "0", 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

export function parsePagination(
  limitRaw?: string | null,
  offsetRaw?: string | null,
  opts?: { defaultLimit?: number; maxLimit?: number },
): PaginationParams {
  return {
    limit: parseLimit(
      limitRaw,
      opts?.defaultLimit ?? 30,
      opts?.maxLimit ?? 200,
    ),
    offset: parseOffset(offsetRaw),
  };
}
