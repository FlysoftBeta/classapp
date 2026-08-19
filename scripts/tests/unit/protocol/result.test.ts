import assert from "node:assert/strict";
import test from "node:test";
import { RemoteIncidentError } from "@/shared/protocol/errors";
import { ResultTools } from "@/shared/protocol/result";

test("ResultTools unwraps successful data and throws correlated panics", () => {
  const meta = { buildId: "test" };
  assert.equal(ResultTools.unwrap(ResultTools.ok("value", meta)), "value");
  assert.throws(
    () =>
      ResultTools.unwrap(
        ResultTools.err(
          { message: "失败", incidentId: "I_abcdefghijklmnopqrstuv" },
          meta,
        ),
      ),
    (error: unknown) => {
      assert.ok(error instanceof RemoteIncidentError);
      assert.equal(error.publicMessage, "失败");
      assert.deepEqual(error.incidentIds, ["I_abcdefghijklmnopqrstuv"]);
      return true;
    },
  );
});
