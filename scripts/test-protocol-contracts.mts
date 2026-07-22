import assert from "node:assert/strict";
import { actionContracts } from "@/shared/protocol/actions";
import {
  CheckedError,
  UncheckedError,
  errorFromData,
} from "@/shared/protocol/errors";
import { eventContracts } from "@/shared/protocol/events";
import { actionResultSchema, ResultTools } from "@/shared/protocol/result";
import { PROTOCOL_VERSION, requestFrameSchema } from "@/shared/protocol/wire";

const createGroup = actionContracts.createGroupAction;
assert.equal(
  createGroup.args.safeParse([{ name: "Test", unexpected: true }]).success,
  false,
  "Action inputs must reject unknown fields",
);
assert.equal(createGroup.args.safeParse([{ name: "Test" }]).success, true);

const fetchPosts = actionContracts.fetchPostsAction;
assert.equal(
  fetchPosts.args.safeParse([
    {
      type: "group",
      group: "group-1",
      before_id: "hard-deleted-post",
      before_sequence: 42,
    },
  ]).success,
  true,
  "Post cursors may carry a sequence fallback for hard-deleted rows",
);
assert.equal(
  fetchPosts.args.safeParse([{ before_sequence: -1 }]).success,
  false,
  "Post sequence fallbacks must be non-negative",
);

assert.equal(
  requestFrameSchema.safeParse({
    v: PROTOCOL_VERSION,
    kind: "request",
    id: "1",
    action: "createGroupAction",
    args: [{ name: "Test" }],
    token: "must-not-travel-per-action",
  }).success,
  false,
  "Action frames must not carry connection authentication state",
);

const meta = { buildId: "test" };
const success = ResultTools.ok({ ok: true as const }, meta);
assert.deepEqual(
  actionResultSchema(actionContracts.logoutAction.output).parse(success),
  success,
);
assert.deepEqual(ResultTools.unwrap(success), { ok: true });

const checked = new CheckedError("SESSION_EXPIRED", "expired", 401, true);
const checkedResult = ResultTools.err(checked.toData(), meta);
assert.throws(
  () => ResultTools.unwrap(checkedResult),
  (error: unknown) =>
    error instanceof Error &&
    (error as { kind?: unknown }).kind === "checked" &&
    (error as { code?: unknown }).code === "SESSION_EXPIRED",
);
const reconstructedChecked = errorFromData(checked.toData());
assert.equal(reconstructedChecked.kind, "checked");
if (reconstructedChecked.kind === "checked") {
  assert.equal(reconstructedChecked.tokenExpired, true);
}

const unchecked = UncheckedError.badRequest("bad request");
assert.throws(
  () => ResultTools.unwrap(ResultTools.err(unchecked.toData(), meta)),
  (error: unknown) =>
    error instanceof Error &&
    (error as { kind?: unknown }).kind === "unchecked" &&
    (error as { code?: unknown }).code === "BAD_REQUEST",
);

assert.equal(
  eventContracts["post.deleted"].safeParse({ id: "post-1", extra: true })
    .success,
  false,
  "Event payloads must reject unknown fields",
);
assert.equal(
  eventContracts["post.deleted"].safeParse({ id: "post-1" }).success,
  true,
);

console.log("protocol contract tests passed");
