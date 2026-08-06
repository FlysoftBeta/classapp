import assert from "node:assert/strict";
import test from "node:test";
import { shouldSegmentArticleStorage } from "./articleSegmentStorage";

test("segments article storage through Chrome 80", () => {
  assert.equal(
    shouldSegmentArticleStorage(
      "Mozilla/5.0 AppleWebKit/537.36 Chrome/70.0.3538.77 Safari/537.36",
    ),
    true,
  );
  assert.equal(
    shouldSegmentArticleStorage(
      "Mozilla/5.0 AppleWebKit/537.36 Chrome/80.0.3987.149 Safari/537.36",
    ),
    true,
  );
});

test("disables article storage segmentation after Chrome 80", () => {
  assert.equal(
    shouldSegmentArticleStorage(
      "Mozilla/5.0 AppleWebKit/537.36 Chrome/81.0.4044.92 Safari/537.36",
    ),
    false,
  );
  assert.equal(
    shouldSegmentArticleStorage(
      "Mozilla/5.0 AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
    ),
    false,
  );
});

test("does not enable the Chrome workaround for other engines", () => {
  assert.equal(
    shouldSegmentArticleStorage("Mozilla/5.0 Gecko/20100101 Firefox/128.0"),
    false,
  );
});
