import assert from "node:assert/strict";
import test from "node:test";
import {
  articleListRootMemberships,
  connectPostPage,
  mergeCursorCoverage,
  postCoverageAfterPrefixDelete,
  postIsInsidePublishedWindow,
  shouldExtendPostCoverage,
} from "@/client/repo/coverage";

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

test("live append extends coverage only from a reached newest bound", () => {
  assert.equal(
    shouldExtendPostCoverage({
      current: {
        newest: { id: "n", order: 10 },
        oldest: { id: "o", order: 1 },
        reached_newest: true,
        reached_oldest: false,
        known_revision: 4,
        revision_sum: "4",
      },
      liveAppend: true,
      incomingSequences: [11, 12],
    }),
    true,
  );
  assert.equal(
    shouldExtendPostCoverage({
      current: {
        newest: { id: "n", order: 10 },
        oldest: { id: "o", order: 1 },
        reached_newest: false,
        reached_oldest: false,
        known_revision: 4,
        revision_sum: "4",
      },
      liveAppend: true,
      incomingSequences: [11],
    }),
    false,
  );
});

test("an overlay post outside the window does not count as inside coverage", () => {
  assert.equal(
    postIsInsidePublishedWindow(
      {
        newest: { id: "n", order: 10 },
        oldest: { id: "o", order: 5 },
        reached_newest: true,
        reached_oldest: false,
        known_revision: 1,
        revision_sum: "1",
      },
      4,
    ),
    false,
  );
});

test("a disconnected cursor page is ignored and a root gap replaces the window", () => {
  assert.equal(
    connectPostPage({
      hasCoverage: false,
      cursorId: "cursor",
      cursorInConversation: false,
      incomingOverlapsExisting: false,
    }),
    "ignore",
  );
  assert.equal(
    connectPostPage({
      hasCoverage: true,
      cursorId: undefined,
      cursorInConversation: false,
      incomingOverlapsExisting: false,
    }),
    "replace-window",
  );
  assert.equal(
    connectPostPage({
      hasCoverage: true,
      cursorId: undefined,
      cursorInConversation: false,
      incomingOverlapsExisting: true,
    }),
    "apply",
  );
});

test("prefix deletion removes empty coverage and drops reached_oldest", () => {
  const current = {
    newest: { id: "n", order: 10 },
    oldest: { id: "o", order: 1 },
    reached_newest: true,
    reached_oldest: true,
    known_revision: 9,
    revision_sum: "9",
  };
  assert.equal(postCoverageAfterPrefixDelete(current, []), "delete");
  assert.deepEqual(
    postCoverageAfterPrefixDelete(current, [
      { id: "a", sequence: 4 },
      { id: "b", sequence: 10 },
    ]),
    {
      ...current,
      oldest: { id: "a", order: 4 },
      newest: { id: "b", order: 10 },
      reached_oldest: false,
    },
  );
});

test("a root article list page drops memberships outside the new proof", () => {
  const { put, remove } = articleListRootMemberships({
    rows: [
      {
        object_id: "kept",
        memberships: [{ view: "all", group_id: null, sort_at: "1" }],
      },
      {
        object_id: "gone",
        memberships: [{ view: "all", group_id: null, sort_at: "2" }],
      },
      {
        object_id: "shared",
        memberships: [
          { view: "all", group_id: null, sort_at: "3" },
          { view: "bookmarked", group_id: null, sort_at: "4" },
        ],
      },
    ],
    pageIds: new Set(["kept"]),
    view: "all",
    groupId: null,
  });
  assert.deepEqual(
    remove.map((row) => row.object_id),
    ["gone"],
  );
  assert.deepEqual(put, [
    {
      object_id: "shared",
      memberships: [{ view: "bookmarked", group_id: null, sort_at: "4" }],
    },
  ]);
});

