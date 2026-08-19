import assert from "node:assert/strict";
import test from "node:test";
import { mergeCursorCoverage } from "@/client/data/coverage";

const boundary = (order: number) => ({ id: `item-${order}`, order });

test("a root after-page starts coverage from newest without claiming oldest", () => {
  const root = mergeCursorCoverage({
    current: null,
    direction: "after",
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
});

test("a connected older page extends the oldest bound", () => {
  const root = mergeCursorCoverage({
    current: null,
    direction: "after",
    cursor: null,
    first: boundary(100),
    last: boundary(90),
    exhausted: false,
  });
  const older = mergeCursorCoverage({
    current: root,
    direction: "after",
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
});

test("a disconnected page does not widen published coverage", () => {
  const root = mergeCursorCoverage({
    current: null,
    direction: "after",
    cursor: null,
    first: boundary(100),
    last: boundary(90),
    exhausted: false,
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
  );
});

test("a connected newer page extends the newest bound", () => {
  const older = mergeCursorCoverage({
    current: {
      newest: boundary(100),
      oldest: boundary(80),
      reached_newest: false,
      reached_oldest: true,
    },
    direction: "before",
    cursor: boundary(100),
    first: boundary(120),
    last: boundary(101),
    exhausted: true,
  });
  assert.deepEqual(older, {
    newest: boundary(120),
    oldest: boundary(80),
    reached_newest: true,
    reached_oldest: true,
  });
});

test("an empty exhausted continuation marks the connected end as reached", () => {
  const current = {
    newest: boundary(100),
    oldest: boundary(90),
    reached_newest: true,
    reached_oldest: false,
  };
  assert.deepEqual(
    mergeCursorCoverage({
      current,
      direction: "after",
      cursor: boundary(90),
      first: null,
      last: null,
      exhausted: true,
    }),
    { ...current, reached_oldest: true },
  );
  assert.deepEqual(
    mergeCursorCoverage({
      current: {
        newest: boundary(100),
        oldest: boundary(90),
        reached_newest: false,
        reached_oldest: true,
      },
      direction: "before",
      cursor: boundary(100),
      first: null,
      last: null,
      exhausted: true,
    }),
    {
      newest: boundary(100),
      oldest: boundary(90),
      reached_newest: true,
      reached_oldest: true,
    },
  );
});

test("an empty root page publishes no coverage", () => {
  assert.equal(
    mergeCursorCoverage({
      current: null,
      direction: "after",
      cursor: null,
      first: null,
      last: null,
      exhausted: true,
    }),
    null,
  );
});

test("an isolated cursor without existing coverage publishes nothing", () => {
  assert.equal(
    mergeCursorCoverage({
      current: null,
      direction: "after",
      cursor: boundary(10),
      first: boundary(9),
      last: boundary(1),
      exhausted: false,
    }),
    null,
  );
});

test("a root page replaces any previous interval", () => {
  const next = mergeCursorCoverage({
    current: {
      newest: boundary(50),
      oldest: boundary(10),
      reached_newest: true,
      reached_oldest: true,
    },
    direction: "after",
    cursor: null,
    first: boundary(80),
    last: boundary(70),
    exhausted: false,
  });
  assert.deepEqual(next, {
    newest: boundary(80),
    oldest: boundary(70),
    reached_newest: true,
    reached_oldest: false,
  });
});
