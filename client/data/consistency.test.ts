import assert from "node:assert/strict";
import {
  changedConversationRevisions,
  collectRevisionRange,
  assertImmutableEntity,
  chooseFurthestRead,
  chooseLww,
  choosePostVersion,
  nextDeviceTimestamp,
} from "./consistency";

async function main() {
  assert.equal(nextDeviceTimestamp(100, 90), 101);
  assert.deepEqual(
    chooseLww(
      { proposed: false, purpose: "mute", timestamp: 10 },
      { proposed: true, purpose: "mute", timestamp: 11 },
    ),
    { proposed: true, purpose: "mute", timestamp: 11 },
  );
  assert.deepEqual(
    choosePostVersion(
      { id: "post", revision: 8, type: "deleted" },
      { id: "post", revision: 7, type: "text" },
    ),
    { id: "post", revision: 8, type: "deleted" },
    "A stale page cannot resurrect a tombstoned post",
  );
  assert.equal(assertImmutableEntity("same", "same", "article:1"), "same");
  assert.throws(
    () => assertImmutableEntity("old", "changed", "article:1"),
    /Immutable entity article:1 changed/,
  );
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
  assert.equal(
    chooseFurthestRead(
      { postId: "later", sequence: 20, timestamp: 1 },
      { postId: "newer-clock", sequence: 19, timestamp: 999 },
    ).postId,
    "later",
  );
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

  console.log("client consistency tests passed");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
