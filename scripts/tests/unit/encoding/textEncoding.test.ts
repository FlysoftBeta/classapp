import assert from "node:assert/strict";
import test from "node:test";
import { decodeUploadedText } from "@/client/lib/textEncoding";

test("decodes valid UTF-8 text as UTF-8", () => {
  const bytes = new TextEncoder().encode("你好，ClassApp");
  assert.deepEqual(decodeUploadedText(bytes), {
    text: "你好，ClassApp",
    encoding: "utf-8",
  });
});

test("decodes a UTF-8 BOM without including it in the text", () => {
  const content = new TextEncoder().encode("带 BOM 的文章");
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...content]);
  assert.deepEqual(decodeUploadedText(bytes), {
    text: "带 BOM 的文章",
    encoding: "utf-8",
  });
});

test("falls back to GBK when the bytes are not valid UTF-8", () => {
  const bytes = new Uint8Array([
    0xc4, 0xe3, 0xba, 0xc3, 0xa3, 0xac, 0xca, 0xc0, 0xbd, 0xe7,
  ]);
  assert.deepEqual(decodeUploadedText(bytes), {
    text: "你好，世界",
    encoding: "gbk",
  });
});

test("prefers UTF-8 for ASCII text, which is valid in both encodings", () => {
  const bytes = new TextEncoder().encode("plain text");
  assert.equal(decodeUploadedText(bytes).encoding, "utf-8");
});
