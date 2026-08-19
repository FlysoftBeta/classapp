import assert from "node:assert/strict";
import test from "node:test";
import { mergeCursorCoverage } from "@/client/data/coverage";

const boundary = (order: number) => ({ id: `item-${order}`, order });

test("a rooted page publishes coverage and a disconnected page does not widen it", () => {
  const root = mergeCursorCoverage({
    current: null,
    direction: "after" as const,
    cursor: null,
    first: boundary(100),
    last: boundary(90),
    exhausted: false,
  });
  assert.deepEqual(root, {
    newest: boundary(100),
    oldest: boundary(90),
    reached_newest: true,
    reached_oldest: false,
  });

  const older = mergeCursorCoverage({
    current: root,
    direction: "after" as const,
    cursor: boundary(90),
    first: boundary(89),
    last: boundary(80),
    exhausted: true,
  });
  assert.deepEqual(older, {
    newest: boundary(100),
    oldest: boundary(80),
    reached_newest: true,
    reached_oldest: true,
  });

  assert.equal(
    mergeCursorCoverage({
      current: root,
      direction: "after",
      cursor: boundary(70),
      first: boundary(69),
      last: boundary(60),
      exhausted: false,
    }),
    null,
    "A disconnected page must not widen published coverage",
  );
});

test("a connected newer page may extend the newest bound", () => {
  const older = {
    newest: boundary(100),
    oldest: boundary(80),
    reached_newest: true,
    reached_oldest: true,
  };
  const newer = mergeCursorCoverage({
    current: older,
    direction: "before" as const,
    cursor: boundary(100),
    first: boundary(120),
    last: boundary(101),
    exhausted: true,
  });
  assert.deepEqual(newer, {
    newest: boundary(120),
    oldest: boundary(80),
    reached_newest: true,
    reached_oldest: true,
  });
});
