import assert from "node:assert/strict";
import test from "node:test";
import { roleDependencies } from "@/shared/authority";

test("specialized administration roles depend on the administrator identity", () => {
  assert.deepEqual(roleDependencies("operations"), ["administrator"]);
  assert.deepEqual(roleDependencies("root"), ["administrator"]);
});

test("advanced community administration also depends on community management", () => {
  assert.deepEqual(roleDependencies("advanced_community_manager"), [
    "administrator",
    "community_manager",
  ]);
});
