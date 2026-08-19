import assert from "node:assert/strict";
import test from "node:test";
import {
  dmConvId,
  groupConvId,
  orderedDmPeers,
  parseConvId,
  peerIdFromDmConvId,
} from "@/shared/conversations/id";

test("group conversation ids are a typed prefix", () => {
  assert.equal(groupConvId("wild"), "group:wild");
  assert.deepEqual(parseConvId("group:wild"), {
    type: "group",
    groupId: "wild",
  });
  assert.equal(parseConvId("group:"), null);
});

test("DM ids order distinct peers and reject malformed ids", () => {
  assert.deepEqual(orderedDmPeers("b", "a"), ["a", "b"]);
  assert.equal(dmConvId("b", "a"), "dm:a:b");
  assert.deepEqual(parseConvId("dm:a:b"), {
    type: "dm",
    peerA: "a",
    peerB: "b",
  });
  assert.equal(parseConvId("dm:b:a"), null);
  assert.equal(parseConvId("dm:a"), null);
  assert.equal(parseConvId("dm:a:b:c"), null);
  assert.throws(() => dmConvId("same", "same"));
  assert.throws(() => dmConvId("a:b", "c"));
});

test("peerIdFromDmConvId returns the other participant", () => {
  assert.equal(peerIdFromDmConvId("dm:a:b", "a"), "b");
  assert.equal(peerIdFromDmConvId("dm:a:b", "b"), "a");
  assert.equal(peerIdFromDmConvId("dm:a:b", "z"), null);
  assert.equal(peerIdFromDmConvId("group:wild", "a"), null);
});
