import assert from "node:assert/strict";
import test from "node:test";
import {
  QUOTA_FALLBACK_TARGET_BYTES,
  QUOTA_FORCE_FLOOR_BYTES,
  quotaEvictionTargetBytes,
  quotaUsageAtOrBelowTarget,
} from "@/client/data/quotaPolicy";

test("quota eviction stays idle below the start watermark", () => {
  assert.equal(
    quotaEvictionTargetBytes({ usage: 80, quota: 100, force: false }),
    0,
  );
  assert.equal(
    quotaEvictionTargetBytes({ usage: 89.9, quota: 100, force: false }),
    0,
  );
});

test("quota eviction targets 80% of quota once usage reaches the start watermark", () => {
  assert.equal(
    quotaEvictionTargetBytes({ usage: 90, quota: 100, force: false }),
    10,
  );
  assert.equal(
    quotaEvictionTargetBytes({ usage: 100, quota: 100, force: false }),
    20,
  );
});

test("forced eviction uses a floor even when usage is already low", () => {
  assert.equal(
    quotaEvictionTargetBytes({ usage: 10, quota: 100, force: true }),
    QUOTA_FORCE_FLOOR_BYTES,
  );
  assert.equal(
    quotaEvictionTargetBytes({ usage: 0, quota: 0, force: true }),
    QUOTA_FALLBACK_TARGET_BYTES,
  );
});

test("unknown quota falls back to a fixed reclaim size", () => {
  assert.equal(
    quotaEvictionTargetBytes({ usage: 50, quota: 0, force: false }),
    0,
  );
  assert.equal(quotaUsageAtOrBelowTarget(80, 100), true);
  assert.equal(quotaUsageAtOrBelowTarget(81, 100), false);
});
