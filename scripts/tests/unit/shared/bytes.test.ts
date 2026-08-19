import assert from "node:assert/strict";
import test from "node:test";
import { bytes, formatBytes } from "@/shared/bytes";

test("bytes literals convert using binary units", () => {
  assert.equal(bytes("200 MB"), 200 * 1024 * 1024);
  assert.equal(bytes("1.5 GB"), 1.5 * 1024 * 1024 * 1024);
  assert.equal(bytes("10 B"), 10);
  assert.throws(() => bytes("12TB" as never));
});

test("formatBytes uses one decimal from KB upward", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1024 * 1024), "1.0 MB");
});
