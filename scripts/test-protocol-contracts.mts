import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { RUNTIME_DATABASE_VERSION, STORES } from "@/client/data/schema";
import { actionContracts } from "@/shared/protocol/actions";
import {
  CheckedError,
  UncheckedError,
  errorFromData,
} from "@/shared/protocol/errors";
import { eventContracts } from "@/shared/protocol/events";
import { actionResultSchema, ResultTools } from "@/shared/protocol/result";
import { PROTOCOL_VERSION, requestFrameSchema } from "@/shared/protocol/wire";
import { rowToArticle } from "@/server/data/articles";

const createGroup = actionContracts.createGroupAction;
assert.equal(
  createGroup.args.safeParse([{ name: "Test", unexpected: true }]).success,
  false,
  "Action inputs must reject unknown fields",
);

const shell = await readFile(new URL("../shell.html", import.meta.url), "utf8");
assert.equal(
  Number(shell.match(/var DB_VERSION = (\d+);/)?.[1]),
  RUNTIME_DATABASE_VERSION,
  "Shell and application must open the same runtime database version",
);
for (const store of Object.values(STORES)) {
  assert.match(
    shell,
    new RegExp(`createObjectStore\\(["']${store}["']`),
    `Shell bootstrap schema is missing ${store}`,
  );
}
assert.doesNotMatch(
  shell,
  /classapp-active-build|entrypoint_code\s*\|\||objectStore\(["']kv["']\)/,
  "The hard schema boundary must not retain legacy bundle/data shims",
);
assert.equal(createGroup.args.safeParse([{ name: "Test" }]).success, true);

const fetchPosts = actionContracts.fetchPostsAction;
assert.equal(
  fetchPosts.args.safeParse([
    {
      type: "conversation",
      conv_id: "group:group-1",
      before_id: "cached-post",
      before_sequence: 42,
      changed_after_revision: 7,
      changed_through_revision: 10,
    },
  ]).success,
  true,
  "Post requests carry stable sequence cursors and revision awareness",
);
assert.equal(
  fetchPosts.args.safeParse([{ before_sequence: -1 }]).success,
  false,
  "Post sequence fallbacks must be non-negative",
);
assert.equal(
  actionContracts.markConversationReadAction.args.safeParse([
    {
      type: "group",
      id: "group-1",
      post_id: "post-1",
      updatedAt: 1,
      merge: "furthest",
    },
  ]).success,
  true,
  "Offline read watermarks use an explicit furthest merge operation",
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

const tombstone = {
  id: "post-1",
  user_id: "user-1",
  conv_id: "group:group-1",
  sequence: 1,
  revision: 4,
  brief: "",
  reply_to: null,
  deleted_at: "2026-01-01 00:00:00",
  edited_at: null,
  created_at: "2026-01-01 00:00:00",
  type: "deleted" as const,
};
assert.equal(
  eventContracts["post.deleted"].safeParse({ post: tombstone, extra: true })
    .success,
  false,
  "Event payloads must reject unknown fields",
);
assert.equal(
  eventContracts["post.deleted"].safeParse({ post: tombstone }).success,
  true,
);

const article = rowToArticle({
  id: "article-1",
  user_id: "user-1",
  group_id: "group-1",
  title: "Contract-safe article",
  provider_json: JSON.stringify({ type: "text", words: 3, chunks: 1 }),
  created_at: "2026-01-01 00:00:00",
  username: "Test User",
  handle: "test-user",
  is_bookmarked: 0,
  bookmark_updated_at_ms: null,
  current_offset: null,
  current_offset_updated_at: null,
  current_locator: null,
  total_read_seconds: null,
  last_read_at: null,
  future_internal_column: "must not cross the protocol boundary",
});
assert.equal(
  "provider_json" in article || "future_internal_column" in article,
  false,
  "Article DTOs must expose only protocol fields, never raw SQL columns",
);
assert.equal(
  actionContracts.fetchArticleSidebarAction.output.safeParse({
    current_article_id: null,
    articles: [article],
  }).success,
  true,
  "Article sidebar output must satisfy its strict contract",
);
assert.equal(
  actionContracts.listArticlesAction.output.safeParse({
    articles: [article],
    hasMore: false,
  }).success,
  true,
  "Article list output must satisfy its strict contract",
);
assert.equal(
  actionContracts.fetchArticleAction.output.safeParse({ article }).success,
  true,
  "Single-article output must satisfy its strict contract",
);

console.log("protocol contract tests passed");
