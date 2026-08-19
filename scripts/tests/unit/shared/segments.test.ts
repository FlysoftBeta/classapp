import assert from "node:assert/strict";
import test from "node:test";
import { splitTextArticle, TEXT_ARTICLE_SEGMENT_SIZE } from "@/shared/articles/segments";

test("segment boundaries do not split a surrogate pair", () => {
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

test("empty text yields no segments and tiny sizes are rejected", () => {
  assert.deepEqual(splitTextArticle(""), []);
  assert.throws(() => splitTextArticle("ab", 1));
});
