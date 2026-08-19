export const QUOTA_START_RATIO = 0.9;
export const QUOTA_TARGET_RATIO = 0.8;
export const QUOTA_MAX_ROUNDS = 4;
export const QUOTA_FALLBACK_TARGET_BYTES = 64 * 1024 * 1024;
export const QUOTA_FORCE_FLOOR_BYTES = 16 * 1024 * 1024;

/**
 * Bytes the quota controller should try to free in one round. 0 means the
 * current estimate is still below the start watermark and no eviction runs.
 */
export function quotaEvictionTargetBytes(input: {
  usage: number;
  quota: number;
  force: boolean;
}): number {
  if (
    !input.force &&
    (!input.quota || input.usage / input.quota < QUOTA_START_RATIO)
  ) {
    return 0;
  }
  if (!input.quota) return QUOTA_FALLBACK_TARGET_BYTES;
  return Math.max(
    input.force ? QUOTA_FORCE_FLOOR_BYTES : 0,
    input.usage - input.quota * QUOTA_TARGET_RATIO,
  );
}

export function quotaUsageAtOrBelowTarget(usage: number, quota: number): boolean {
  return !quota || usage / quota <= QUOTA_TARGET_RATIO;
}
