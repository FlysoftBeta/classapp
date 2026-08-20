import assert from "node:assert/strict";
import type { SmokeRuntime } from "../harness";

export async function smokeArticles(runtime: SmokeRuntime): Promise<void> {
  const listed = await runtime.client.expectOk("listArticlesAction", [{}]);
  assert.ok(Array.isArray(listed.articles));
  assert.equal(typeof listed.hasMore, "boolean");
  const library = await runtime.client.expectOk("articlesLibraryAction", []);
  assert.ok(Array.isArray(library.recents));
  assert.ok(Array.isArray(library.favorites));
  assert.ok(Array.isArray(library.booklists));
  const created = await runtime.client.expectOk("booklistCreateAction", [
    { title: "测试文单" },
  ]);
  assert.equal(created.list.title, "测试文单");
  assert.equal(created.list.access.own, true);
  const booklists = await runtime.client.expectOk("booklistListAction", []);
  assert.ok(booklists.booklists.some((entry) => entry.id === created.list.id));
  const sidebar = await runtime.client.expectOk("fetchArticleSidebarAction", []);
  assert.ok(Array.isArray(sidebar.articles));
  assert.ok(Array.isArray(sidebar.users));
}
