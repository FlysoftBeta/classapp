import assert from "node:assert/strict";
import test from "node:test";
import { Assignments } from "@/client/repo/assignment";
import { mergeArticleListMemberships } from "@/client/repo/coverage";
import { mergeSnapshotAssignment } from "@/client/repo/snapshot";

test("a snapshot base cannot clear a strictly newer proposal", () => {
  const current = Assignments.propose(Assignments.assignment(false, 5), true, 9);
  const merged = mergeSnapshotAssignment(current, { value: false, updatedAt: 8 });
  assert.equal(merged.base.value, false);
  assert.equal(merged.proposal?.value, true);
  assert.equal(
    mergeSnapshotAssignment(current, { value: false, updatedAt: 9 }).proposal,
    null,
  );
});

test("snapshot membership replaces the same view/filter and keeps others", () => {
  assert.deepEqual(
    mergeArticleListMemberships(
      [
        { view: "all", group_id: null, sort_at: "1" },
        { view: "bookmarked", group_id: null, sort_at: "2" },
      ],
      { view: "all", group_id: null, sort_at: "9" },
    ),
    [
      { view: "bookmarked", group_id: null, sort_at: "2" },
      { view: "all", group_id: null, sort_at: "9" },
    ],
  );
});
