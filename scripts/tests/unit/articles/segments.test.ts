import assert from "node:assert/strict";
import test from "node:test";
import {
  splitTextArticle,
  TEXT_ARTICLE_SEGMENT_SIZE,
} from "@/shared/articles/segments";

test("text article segmentation keeps UTF-16 offsets and does not split surrogates", () => {
  const text = `${"甲".repeat(TEXT_ARTICLE_SEGMENT_SIZE - 1)}😀乙`;
  const segments = splitTextArticle(text);
  assert.deepEqual(
    segments.map(({ startOffset, content }) => ({ startOffset, content })),
    [
      {
        startOffset: 0,
        content: "甲".repeat(TEXT_ARTICLE_SEGMENT_SIZE - 1),
      },
      { startOffset: TEXT_ARTICLE_SEGMENT_SIZE - 1, content: "😀乙" },
    ],
  );
  assert.equal(segments.map((segment) => segment.content).join(""), text);
  assert.ok(
    segments.every(
      (segment) => segment.content.length <= TEXT_ARTICLE_SEGMENT_SIZE,
    ),
  );
});
