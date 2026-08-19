import assert from "node:assert/strict";
import type { SmokeRuntime } from "../harness";

export async function smokePosts(runtime: SmokeRuntime): Promise<void> {
  const created = await runtime.client.expectOk("createPostAction", [
    { conv_id: "group:wild", content: "smoke post 你好" },
  ]);
  assert.equal(created.post.conv_id, "group:wild");
  assert.ok(created.post.id);
  assert.ok(created.users.some((user) => user.id === runtime.userId));

  const listed = await runtime.client.expectOk("fetchPostsAction", [
    { type: "conversation", conv_id: "group:wild", limit: "20" },
  ]);
  assert.ok(listed.posts.some((post) => post.id === created.post.id));

  const fetched = await runtime.client.expectOk("fetchPostAction", [
    created.post.id,
  ]);
  assert.equal(fetched.post.id, created.post.id);

  const updated = await runtime.client.expectOk("updatePostAction", [
    { postId: created.post.id, text: "smoke post edited" },
  ]);
  assert.equal(updated.post.id, created.post.id);

  await runtime.client.expectOk("markConversationReadAction", [
    {
      type: "group",
      id: "wild",
      post_id: created.post.id,
      updatedAt: Date.now(),
      merge: "furthest",
    },
  ]);

  const deleted = await runtime.client.expectOk("deletePostAction", [
    created.post.id,
  ]);
  assert.equal(deleted.post.id, created.post.id);
}
