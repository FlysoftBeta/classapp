import assert from "node:assert/strict";
import test from "node:test";
import {
  dmConvId,
  groupConvId,
  parseConvId,
  peerIdFromDmConvId,
} from "@/shared/conversations/id";

test("group conversation ids are a typed prefix of the group id", () => {
  assert.equal(groupConvId("abc"), "group:abc");
  assert.deepEqual(parseConvId("group:abc"), {
    type: "group",
    groupId: "abc",
  });
  assert.equal(parseConvId("group:"), null);
});

test("DM conversation ids sort peers and reject inverted or incomplete forms", () => {
  assert.equal(dmConvId("b", "a"), "dm:a:b");
  assert.deepEqual(parseConvId("dm:a:b"), {
    type: "dm",
    peerA: "a",
    peerB: "b",
  });
  assert.equal(parseConvId("dm:b:a"), null);
  assert.equal(parseConvId("dm:a:a"), null);
  assert.equal(parseConvId("dm:a"), null);
  assert.throws(() => dmConvId("same", "same"));
  assert.throws(() => dmConvId("a:b", "c"));
});

test("a DM peer lookup only returns the other participant", () => {
  assert.equal(peerIdFromDmConvId("dm:a:b", "a"), "b");
  assert.equal(peerIdFromDmConvId("dm:a:b", "b"), "a");
  assert.equal(peerIdFromDmConvId("dm:a:b", "c"), null);
  assert.equal(peerIdFromDmConvId("group:x", "a"), null);
});
