import assert from "node:assert/strict";
import test from "node:test";
import {
  ALL_ACCESS_GRANTS,
  EMPTY_ACCESS_FLAGS,
  canIssueGrant,
  flagsCanIssue,
  flagsCover,
  flagsOf,
  flagsOfGrantSet,
  flagsSatisfy,
  grantDominates,
  isSubsetGrant,
  mergeIncomingGrant,
  normalizeGrantSet,
  unionFlags,
  type AccessGrant,
} from "@/shared/access";

function everyPair(
  visit: (source: AccessGrant, derived: AccessGrant) => void,
): void {
  for (const source of ALL_ACCESS_GRANTS) {
    for (const derived of ALL_ACCESS_GRANTS) visit(source, derived);
  }
}

test("owner flags cover every other grant", () => {
  const owner = flagsOf({ mode: "owner" });
  for (const grant of ALL_ACCESS_GRANTS) {
    assert.equal(flagsCover(owner, flagsOf(grant)), true);
  }
});

test("empty flags cover only the empty set", () => {
  assert.equal(flagsCover(EMPTY_ACCESS_FLAGS, EMPTY_ACCESS_FLAGS), true);
  assert.equal(flagsCover(EMPTY_ACCESS_FLAGS, flagsOf({ mode: "read", shareable: false })), false);
});

test("issuable subset: owner may issue every grant", () => {
  for (const derived of ALL_ACCESS_GRANTS) {
    assert.equal(canIssueGrant({ mode: "owner" }, derived), true);
    assert.equal(isSubsetGrant(derived, { mode: "owner" }), true);
  }
});

test("issuable subset: non-shareable grants cannot issue anything", () => {
  const holders: AccessGrant[] = [
    { mode: "readwrite", shareable: false },
    { mode: "read", shareable: false },
  ];
  for (const holder of holders) {
    for (const derived of ALL_ACCESS_GRANTS) {
      assert.equal(canIssueGrant(holder, derived), false);
    }
  }
});

test("issuable subset: shareable read cannot escalate to write or owner", () => {
  const holder: AccessGrant = { mode: "read", shareable: true };
  assert.equal(canIssueGrant(holder, { mode: "owner" }), false);
  assert.equal(canIssueGrant(holder, { mode: "readwrite", shareable: true }), false);
  assert.equal(canIssueGrant(holder, { mode: "readwrite", shareable: false }), false);
  assert.equal(canIssueGrant(holder, { mode: "read", shareable: true }), true);
  assert.equal(canIssueGrant(holder, { mode: "read", shareable: false }), true);
});

test("issuable subset: shareable readwrite may issue any non-owner restriction", () => {
  const holder: AccessGrant = { mode: "readwrite", shareable: true };
  assert.equal(canIssueGrant(holder, { mode: "owner" }), false);
  assert.equal(canIssueGrant(holder, { mode: "readwrite", shareable: true }), true);
  assert.equal(canIssueGrant(holder, { mode: "readwrite", shareable: false }), true);
  assert.equal(canIssueGrant(holder, { mode: "read", shareable: true }), true);
  assert.equal(canIssueGrant(holder, { mode: "read", shareable: false }), true);
});

test("every issuable pair is a flag restriction of the source", () => {
  everyPair((source, derived) => {
    if (canIssueGrant(source, derived)) {
      assert.equal(
        flagsCover(flagsOf(source), flagsOf(derived)),
        true,
        `${JSON.stringify(derived)} issued from ${JSON.stringify(source)} must be a flag subset`,
      );
    }
  });
});

test("no grant can issue a strictly stronger grant", () => {
  everyPair((source, derived) => {
    const sourceFlags = flagsOf(source);
    const derivedFlags = flagsOf(derived);
    if (!flagsCover(sourceFlags, derivedFlags)) {
      assert.equal(
        canIssueGrant(source, derived),
        false,
        `escalation ${JSON.stringify(source)} -> ${JSON.stringify(derived)}`,
      );
    }
  });
});

test("union of shareable-read and non-shareable-write does not create shareable write", () => {
  const merged = unionFlags(
    flagsOf({ mode: "read", shareable: true }),
    flagsOf({ mode: "readwrite", shareable: false }),
  );
  assert.equal(merged.read, true);
  assert.equal(merged.write, true);
  assert.equal(merged.shareRead, true);
  assert.equal(merged.shareWrite, false);
  assert.equal(merged.own, false);
  assert.equal(flagsCanIssue(merged, { mode: "read", shareable: true }), true);
  assert.equal(flagsCanIssue(merged, { mode: "readwrite", shareable: false }), false);
  assert.equal(flagsCanIssue(merged, { mode: "readwrite", shareable: true }), false);
  assert.equal(flagsSatisfy(merged, "write"), true);
  assert.equal(flagsSatisfy(merged, "own"), false);
  assert.equal(flagsSatisfy(merged, { share: { mode: "read", shareable: false } }), true);
});

test("normalizeGrantSet drops dominated grants and keeps incomparable ones", () => {
  assert.deepEqual(
    normalizeGrantSet([
      { mode: "read", shareable: false },
      { mode: "read", shareable: true },
      { mode: "read", shareable: true },
    ]),
    [{ mode: "read", shareable: true }],
  );
  assert.deepEqual(normalizeGrantSet([{ mode: "readwrite", shareable: false }, { mode: "owner" }]), [
    { mode: "owner" },
  ]);
  const mixed = normalizeGrantSet([
    { mode: "read", shareable: true },
    { mode: "readwrite", shareable: false },
  ]);
  assert.equal(mixed.length, 2);
  assert.deepEqual(flagsOfGrantSet(mixed), unionFlags(
    flagsOf({ mode: "read", shareable: true }),
    flagsOf({ mode: "readwrite", shareable: false }),
  ));
});

test("mergeIncomingGrant never upgrades shareable write from mixed grants", () => {
  const merged = mergeIncomingGrant(
    [{ mode: "read", shareable: true }],
    { mode: "readwrite", shareable: false },
  );
  const flags = flagsOfGrantSet(merged);
  assert.equal(flags.shareWrite, false);
  assert.equal(flags.write, true);
  assert.equal(flags.shareRead, true);
});

test("shareable readwrite dominates every non-owner grant", () => {
  const top: AccessGrant = { mode: "readwrite", shareable: true };
  for (const other of ALL_ACCESS_GRANTS) {
    if (other.mode === "owner") {
      assert.equal(grantDominates(top, other), false);
    } else {
      assert.equal(grantDominates(top, other), true);
    }
  }
});
