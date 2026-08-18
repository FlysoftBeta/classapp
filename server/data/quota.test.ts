import assert from "node:assert/strict";
import test from "node:test";
import { evictScore, heatNow } from "./quota";

test("heat decays by half after one half-life", () => {
  assert.equal(heatNow(8, 0, 1000, 1000), 4);
});

test("heat is unchanged when no time has passed", () => {
  assert.equal(heatNow(3, 50, 50, 1000), 3);
});

test("heat does not grow when the clock moves backwards", () => {
  assert.equal(heatNow(3, 100, 40, 1000), 3);
});

test("eviction score is hold cost over current heat", () => {
  assert.ok(Math.abs(evictScore(100, 2) - 50) < 1e-6);
});

test("a colder item ranks above a hotter item of the same weight", () => {
  assert.ok(evictScore(100, 0.5) > evictScore(100, 4));
});
