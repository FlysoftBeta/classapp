import assert from "node:assert/strict";
import test from "node:test";
import {
  assertImmutableEntity,
  changedConversationRevisions,
  chooseFurthestRead,
  chooseLww,
  choosePostVersion,
  collectRevisionRange,
  nextDeviceTimestamp,
} from "@/client/interact/consistency";

test("nextDeviceTimestamp stays monotonic when the wall clock goes backwards", () => {
  assert.equal(nextDeviceTimestamp(100, 90), 101);
  assert.equal(nextDeviceTimestamp(0, 0), 1);
  assert.equal(nextDeviceTimestamp(50, 50), 51);
  assert.equal(nextDeviceTimestamp(10, 250), 250);
});

test("LWW keeps the newer device time and resolves ties to the remote value", () => {
  assert.deepEqual(
    chooseLww(
      { proposed: false, purpose: "mute", timestamp: 10 },
      { proposed: true, purpose: "mute", timestamp: 11 },
    ),
    { proposed: true, purpose: "mute", timestamp: 11 },
  );
  assert.deepEqual(
    chooseLww(
      { proposed: "local", purpose: "draft", timestamp: 8 },
      { proposed: "remote", purpose: "draft", timestamp: 8 },
    ),
    { proposed: "remote", purpose: "draft", timestamp: 8 },
  );
  assert.deepEqual(
    chooseLww(null, { proposed: true, purpose: "pin", timestamp: 1 }),
    { proposed: true, purpose: "pin", timestamp: 1 },
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
  assert.deepEqual(
    choosePostVersion(null, { id: "post", revision: 1, type: "text" }),
    { id: "post", revision: 1, type: "text" },
  );
  assert.deepEqual(
    choosePostVersion(
      { id: "post", revision: 4, type: "text" },
      { id: "post", revision: 4, type: "deleted" },
    ),
    { id: "post", revision: 4, type: "deleted" },
    "Equal revisions keep the incoming row so a catch-up page can replace a cache copy",
  );
});

test("read watermarks prefer sequence over wall clock", () => {
  assert.equal(
    chooseFurthestRead(
      { postId: "later", sequence: 20, timestamp: 1 },
      { postId: "newer-clock", sequence: 19, timestamp: 999 },
    ).postId,
    "later",
  );
  assert.equal(
    chooseFurthestRead(
      { postId: "older-seq", sequence: 4, timestamp: 50 },
      { postId: "same-seq-newer", sequence: 4, timestamp: 80 },
    ).postId,
    "same-seq-newer",
  );
  assert.equal(
    chooseFurthestRead(
      { postId: "tie", sequence: 1, timestamp: 10 },
      { postId: "remote-tie", sequence: 1, timestamp: 10 },
    ).postId,
    "remote-tie",
  );
});

test("changed conversation revisions are only those that advanced", () => {
  assert.deepEqual(
    changedConversationRevisions(
      [{ conv_id: "group:a", revision: 2 }],
      [
        { conv_id: "group:a", revision: 3 },
        { conv_id: "group:b", revision: 1 },
        { conv_id: "group:a", revision: 2 },
      ],
    ),
    [
      { conv_id: "group:a", revision: 3 },
      { conv_id: "group:b", revision: 1 },
    ],
  );
  assert.deepEqual(
    changedConversationRevisions([], [{ conv_id: "group:a", revision: 0 }]),
    [],
  );
});

test("immutable entities may be cached again but cannot change bytes", () => {
  assert.equal(assertImmutableEntity("same", "same", "article:1"), "same");
  assert.equal(assertImmutableEntity(null, "first", "article:1"), "first");
  assert.throws(
    () => assertImmutableEntity("old", "changed", "article:1"),
    /Immutable entity article:1 changed/,
  );
});

test("collectRevisionRange pages until a short page and rejects a stuck cursor", async () => {
  assert.deepEqual(await collectRevisionRange(5, 5, async () => [{ revision: 9 }]), []);
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
  await assert.rejects(
    collectRevisionRange(0, 3, async () => [{ revision: 1 }], 0),
    /Revision page size must be positive/,
  );
});

test("a short catch-up page may finish before the advertised upper revision", async () => {
  const rows = await collectRevisionRange(
    0,
    10,
    async () => [{ revision: 2 }, { revision: 4 }],
    10,
  );
  assert.deepEqual(rows, [{ revision: 2 }, { revision: 4 }]);
});
