import assert from "node:assert/strict";
import test from "node:test";
import { Assignments, statePending } from "@/client/repo/assignment";

test("resolved assignment prefers a strictly newer proposal", () => {
  const pending = Assignments.propose(
    Assignments.assignment("base", 10),
    "local",
    20,
  );
  assert.deepEqual(Assignments.resolved(pending), {
    value: "local",
    updatedAt: 20,
    pending: true,
  });
  const staleProposal = {
    base: { value: "base", updated_at: 10 },
    proposal: { value: "old", updated_at: 10, operation_id: "op" },
  };
  assert.deepEqual(Assignments.resolved(staleProposal), {
    value: "base",
    updatedAt: 10,
    pending: false,
  });
});

test("reconcile drops a proposal that is not newer than the canonical timestamp", () => {
  const current = Assignments.propose(Assignments.assignment(false, 5), true, 8);
  assert.equal(Assignments.reconcile(current, { value: false, updatedAt: 8 }).proposal, null);
  const kept = Assignments.reconcile(current, { value: false, updatedAt: 7 });
  assert.equal(kept.proposal?.value, true);
  assert.equal(kept.base.value, false);
});

test("propose advances a monotonic clock even when Date.now does not move", () => {
  const first = Assignments.propose(null, "a", undefined, 100);
  const second = Assignments.propose(first, "b", undefined, 100);
  assert.equal(first.proposal?.updated_at, 100);
  assert.equal(second.proposal?.updated_at, 101);
});

test("JSON equality is used for immutable-sized values", () => {
  assert.equal(Assignments.equal({ a: 1 }, { a: 1 }), true);
  assert.equal(Assignments.equal({ a: 1 }, { a: 2 }), false);
  assert.ok(Assignments.size({ hello: "你好" }) > 0);
  assert.throws(() => Assignments.size(undefined as unknown as object));
});

test("pending is true when any assignment field still has a proposal", () => {
  const pending = Assignments.propose(Assignments.assignment(false), true, 2);
  assert.equal(statePending({ pinned: pending, muted: Assignments.assignment(false) }), 1);
  assert.equal(
    statePending({
      pinned: Assignments.assignment(false),
      muted: Assignments.assignment(true),
    }),
    0,
  );
});

