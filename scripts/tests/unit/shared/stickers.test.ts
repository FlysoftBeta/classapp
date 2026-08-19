import assert from "node:assert/strict";
import test from "node:test";
import { parseRecentStickerRefs, pushRecentSticker } from "@/shared/stickers/recent";

test("recent sticker JSON ignores malformed and duplicate refs", () => {
  assert.deepEqual(parseRecentStickerRefs(null), []);
  assert.deepEqual(parseRecentStickerRefs("not-json"), []);
  assert.deepEqual(
    parseRecentStickerRefs(
      JSON.stringify([
        { pack: "ok", id: "one" },
        { pack: "ok", id: "one" },
        { pack: "../x", id: "bad" },
        { pack: "ok", id: "two" },
      ]),
    ),
    [
      { pack: "ok", id: "one" },
      { pack: "ok", id: "two" },
    ],
  );
});

test("pushRecentSticker moves a sticker to the front and caps the list", () => {
  const next = pushRecentSticker(
    [
      { pack: "a", id: "1" },
      { pack: "b", id: "2" },
    ],
    { pack: "b", id: "2" },
  );
  assert.deepEqual(next[0], { pack: "b", id: "2" });
  assert.equal(next.length, 2);
});
