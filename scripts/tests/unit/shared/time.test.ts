import assert from "node:assert/strict";
import test from "node:test";
import { formatRemaining, isFuture, parseDbTime, toDbTimestamp } from "@/shared/time";

test("SQLite space-separated timestamps parse as UTC, not local time", () => {
  assert.equal(
    parseDbTime("2026-08-15 12:34:56").toISOString(),
    "2026-08-15T12:34:56.000Z",
  );
  assert.equal(
    parseDbTime("2026-08-15T12:34:56Z").toISOString(),
    "2026-08-15T12:34:56.000Z",
  );
  assert.equal(
    parseDbTime("2026-08-15").toISOString(),
    "2026-08-15T00:00:00.000Z",
  );
});

test("toDbTimestamp writes the SQLite UTC format", () => {
  assert.equal(
    toDbTimestamp(Date.parse("2026-08-15T12:34:56Z")),
    "2026-08-15 12:34:56",
  );
});

test("isFuture is false for missing or past timestamps", () => {
  assert.equal(isFuture(null), false);
  assert.equal(isFuture("2000-01-01 00:00:00"), false);
  assert.equal(isFuture("2999-01-01 00:00:00"), true);
});

test("formatRemaining reports a past timestamp as 已解除", () => {
  assert.equal(formatRemaining("2000-01-01 00:00:00"), "已解除");
});
