import assert from "node:assert/strict";
import test from "node:test";
import { parseServerTime } from "./deviceTime";

test("parses offset-less database timestamps as UTC", () => {
  assert.equal(
    parseServerTime("2026-08-15 12:34:56").toISOString(),
    "2026-08-15T12:34:56.000Z",
  );
});

test("preserves explicit timestamp offsets", () => {
  assert.equal(
    parseServerTime("2026-08-15T20:34:56+08:00").toISOString(),
    "2026-08-15T12:34:56.000Z",
  );
});

test("parses date-only server values at UTC midnight", () => {
  assert.equal(
    parseServerTime("2026-08-15").toISOString(),
    "2026-08-15T00:00:00.000Z",
  );
});
