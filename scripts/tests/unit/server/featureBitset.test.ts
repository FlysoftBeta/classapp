import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeFeatureBitset,
  encodeFeatureBitset,
  isValidFeatureBitset,
} from "@/server/data/featureBitset";
import { DEFAULT_USER_FEATURES } from "@/shared/features";

test("feature bitset is a lossless Data-only encoding", () => {
  const features = {
    ...DEFAULT_USER_FEATURES,
    ai: false,
    article_download: false,
  };
  assert.deepEqual(decodeFeatureBitset(encodeFeatureBitset(features)), features);
});

test("feature bitset rejects bits outside the current storage layout", () => {
  assert.equal(isValidFeatureBitset(-1), false);
  assert.equal(isValidFeatureBitset(2 ** 20), false);
  assert.equal(isValidFeatureBitset(0), true);
});
