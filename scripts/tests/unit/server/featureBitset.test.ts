import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeFeatureBitset,
  encodeFeatureBitset,
  featureBit,
  isValidFeatureBitset,
} from "@/server/data/featureBitset";
import { DEFAULT_USER_FEATURES } from "@/shared/features";

test("feature bitset is a lossless Data-only encoding", () => {
  const features = {
    ...DEFAULT_USER_FEATURES,
    ai: false,
    article_download: false,
    post_images: false,
  };
  assert.deepEqual(decodeFeatureBitset(encodeFeatureBitset(features)), features);
});

test("default accounts include the post_images product feature", () => {
  const encoded = encodeFeatureBitset(DEFAULT_USER_FEATURES);
  assert.equal(decodeFeatureBitset(encoded).post_images, true);
  assert.equal((encoded & featureBit("post_images")) !== 0, true);
});

test("feature bitset rejects bits outside the current storage layout", () => {
  assert.equal(isValidFeatureBitset(-1), false);
  assert.equal(isValidFeatureBitset(2 ** 20), false);
  assert.equal(isValidFeatureBitset(0), true);
});
