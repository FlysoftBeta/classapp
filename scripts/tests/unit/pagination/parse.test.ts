import assert from "node:assert/strict";
import test from "node:test";
import {
  parseLimit,
  parseOffset,
  parsePagination,
} from "@/server/validation/pagination";

test("parseLimit falls back for non-positive values and caps at max", () => {
  assert.equal(parseLimit(undefined), 30);
  assert.equal(parseLimit("0"), 30);
  assert.equal(parseLimit("-3"), 30);
  assert.equal(parseLimit("nope"), 30);
  assert.equal(parseLimit("999", 30, 200), 200);
  assert.equal(parseLimit("12"), 12);
});

test("parseOffset never goes negative", () => {
  assert.equal(parseOffset(undefined), 0);
  assert.equal(parseOffset("-4"), 0);
  assert.equal(parseOffset("8"), 8);
});

test("parsePagination composes limit and offset", () => {
  assert.deepEqual(parsePagination("50", "10"), { limit: 50, offset: 10 });
});
