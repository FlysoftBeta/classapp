import assert from "node:assert/strict";
import test from "node:test";
import {
  chooseFurthestRead,
  chooseLatestTimestamped,
} from "@/shared/sync/arbitration";

test("timestamped arbitration keeps the later clock and remote on a tie", () => {
  assert.equal(
    chooseLatestTimestamped(
      { value: "local", updatedAt: 4 },
      { value: "remote", updatedAt: 5 },
    ).value,
    "remote",
  );
  assert.equal(
    chooseLatestTimestamped(
      { value: "local", updatedAt: 9 },
      { value: "remote", updatedAt: 9 },
    ).value,
    "remote",
  );
  assert.equal(
    chooseLatestTimestamped(null, { value: "remote", updatedAt: 1 }).value,
    "remote",
  );
});

test("ordered read position is monotonic in sequence, then timestamp", () => {
  assert.equal(
    chooseFurthestRead(
      { postId: "a", sequence: 8, updatedAt: 1 },
      { postId: "b", sequence: 3, updatedAt: 99 },
    ).postId,
    "a",
  );
  assert.equal(
    chooseFurthestRead(
      { postId: "a", sequence: 8, updatedAt: 1 },
      { postId: "b", sequence: 8, updatedAt: 2 },
    ).postId,
    "b",
  );
});
