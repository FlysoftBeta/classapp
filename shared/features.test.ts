import assert from "node:assert/strict";
import test from "node:test";
import {
  ADMIN_FEATURE_MASK,
  DEFAULT_FEATURE_MASK,
  FEATURE_GATES,
  MAX_FEATURE_MASK,
  hasFeature,
  isValidFeatureMask,
} from "./features";

test("feature mask range includes every declared feature gate", () => {
  assert.equal(MAX_FEATURE_MASK, 2 ** FEATURE_GATES.length - 1);
  assert.equal(ADMIN_FEATURE_MASK, MAX_FEATURE_MASK);
  assert.equal(
    hasFeature({ feature_mask: DEFAULT_FEATURE_MASK }, "admin"),
    false,
  );

  for (const gate of FEATURE_GATES) {
    assert.equal(hasFeature({ feature_mask: ADMIN_FEATURE_MASK }, gate), true);
  }
});

test("feature mask validation accepts the article-download bit", () => {
  assert.equal(isValidFeatureMask(64), true);
  assert.equal(isValidFeatureMask(DEFAULT_FEATURE_MASK), true);
  assert.equal(isValidFeatureMask(ADMIN_FEATURE_MASK), true);
  assert.equal(isValidFeatureMask(-1), false);
  assert.equal(isValidFeatureMask(MAX_FEATURE_MASK + 1), false);
  assert.equal(isValidFeatureMask(1.5), false);
});
