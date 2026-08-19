import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_USER_FEATURES,
  FEATURES,
  hasFeature,
  userFeaturesSchema,
} from "@/shared/features";

test("default product features are enabled independently of administration", () => {
  for (const feature of FEATURES) {
    assert.equal(
      hasFeature({ features: DEFAULT_USER_FEATURES }, feature),
      true,
    );
  }
});

test("feature values form a strict semantic object", () => {
  assert.equal(
    userFeaturesSchema.safeParse(DEFAULT_USER_FEATURES).success,
    true,
  );
  assert.equal(
    userFeaturesSchema.safeParse({ ...DEFAULT_USER_FEATURES, admin: true })
      .success,
    false,
  );
});
