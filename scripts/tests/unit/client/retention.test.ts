import assert from "node:assert/strict";
import test from "node:test";
import {
  articleRetentionActive,
  articleRetentionExpiry,
  conversationRetentionCutoff,
} from "@/client/data/retentionPolicy";

test("conversation retention cutoffs are policy day windows from now", () => {
  const now = Date.UTC(2026, 7, 19);
  assert.equal(conversationRetentionCutoff("auto", now), null);
  assert.equal(conversationRetentionCutoff("week", now), now - 7 * 86_400_000);
  assert.equal(
    conversationRetentionCutoff("half-year", now),
    now - 180 * 86_400_000,
  );
});

test("article retention expires after the selected day count", () => {
  const now = 1_000_000;
  assert.equal(articleRetentionExpiry(1, now), now + 86_400_000);
  assert.equal(articleRetentionActive({ mode: "auto" }, now), true);
  assert.equal(
    articleRetentionActive({ mode: "retained", days: 1, expiresAt: now + 1 }, now),
    true,
  );
  assert.equal(
    articleRetentionActive({ mode: "retained", days: 1, expiresAt: now }, now),
    false,
  );
});
