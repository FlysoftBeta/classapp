import assert from "node:assert/strict";
import type { SmokeRuntime } from "../harness";

export async function smokeArticles(runtime: SmokeRuntime): Promise<void> {
  const listed = await runtime.client.expectOk("listArticlesAction", [{}]);
  assert.ok(Array.isArray(listed.articles));
  assert.equal(typeof listed.hasMore, "boolean");
  const sidebar = await runtime.client.expectOk("fetchArticleSidebarAction", []);
  assert.ok(Array.isArray(sidebar.articles));
  assert.ok(Array.isArray(sidebar.users));
}
