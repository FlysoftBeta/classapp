import assert from "node:assert/strict";
import test from "node:test";
import { fact, Facts } from "./facts";

test("Facts initialize once and can be explicitly invalidated", () => {
  const facts = new Facts();
  const value = fact<number>("test.value");
  let loads = 0;

  assert.equal(
    facts.getOrInit(value, () => ++loads),
    1,
  );
  assert.equal(
    facts.getOrInit(value, () => ++loads),
    1,
  );
  assert.equal(loads, 1);

  facts.invalidate(value);
  assert.equal(
    facts.getOrInit(value, () => ++loads),
    2,
  );
});

test("Facts can be updated after a write for read-your-writes", () => {
  const facts = new Facts();
  const membership = fact<boolean>("group.membership");
  facts.set(membership, true);
  assert.equal(
    facts.getOrInit(membership, () => false),
    true,
  );
});
