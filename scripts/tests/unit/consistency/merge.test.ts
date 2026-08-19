import assert from "node:assert/strict";
import test from "node:test";
import {
  changedConversationRevisions,
  collectRevisionRange,
  assertImmutableEntity,
  chooseFurthestRead,
  chooseLww,
  choosePostVersion,
  nextDeviceTimestamp,
} from "@/client/interact/consistency";

test("device timestamps are monotonic even when the wall clock moves backwards", () => {
  assert.equal(nextDeviceTimestamp(100, 90), 101);
});

test("LWW assignment keeps the later timestamp and the remote value on a tie", () => {
  assert.deepEqual(
    chooseLww(
      { proposed: false, purpose: "mute", timestamp: 10 },
      { proposed: true, purpose: "mute", timestamp: 11 },
    ),
    { proposed: true, purpose: "mute", timestamp: 11 },
  );
  assert.deepEqual(
    chooseLww(
      { proposed: "local", purpose: "theme", timestamp: 5 },
      { proposed: "canonical", purpose: "theme", timestamp: 5 },
    ),
    { proposed: "canonical", purpose: "theme", timestamp: 5 },
  );
});

test("a stale page cannot resurrect a tombstoned post", () => {
  assert.deepEqual(
    choosePostVersion(
      { id: "post", revision: 8, type: "deleted" },
      { id: "post", revision: 7, type: "text" },
    ),
    { id: "post", revision: 8, type: "deleted" },
  );
});

test("immutable entities reject byte disagreement under the same identity", () => {
  assert.equal(assertImmutableEntity("same", "same", "article:1"), "same");
  assert.throws(
    () => assertImmutableEntity("old", "changed", "article:1"),
    /Immutable entity article:1 changed/,
  );
});

test("furthest-read is a grow-only watermark by sequence, not wall clock", () => {
  assert.equal(
    chooseFurthestRead(
      { postId: "later", sequence: 20, timestamp: 1 },
      { postId: "newer-clock", sequence: 19, timestamp: 999 },
    ).postId,
    "later",
  );
});

test("revision catch-up pages until the certified upper bound", async () => {
  assert.deepEqual(
    await collectRevisionRange(
      0,
      3,
      async (cursor) =>
        cursor === 0 ? [{ revision: 1 }, { revision: 2 }] : [{ revision: 3 }],
      2,
    ),
    [{ revision: 1 }, { revision: 2 }, { revision: 3 }],
  );
  await assert.rejects(
    collectRevisionRange(0, 3, async () => [{ revision: 1 }], 1),
    /Revision page did not advance/,
  );
});

test("only conversations whose remote revision advanced are returned", () => {
  assert.deepEqual(
    changedConversationRevisions(
      [{ conv_id: "group:a", revision: 2 }],
      [
        { conv_id: "group:a", revision: 3 },
        { conv_id: "group:b", revision: 1 },
      ],
    ),
    [
      { conv_id: "group:a", revision: 3 },
      { conv_id: "group:b", revision: 1 },
    ],
  );
});
