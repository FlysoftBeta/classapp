import assert from "node:assert/strict";
import jpegJs from "jpeg-js";
import type { SmokeRuntime } from "../harness";
import { isImagePost } from "@/shared/types/api";

function jpegBytes(width: number, height: number): Buffer {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 40;
    data[i + 1] = 120;
    data[i + 2] = 200;
    data[i + 3] = 255;
  }
  const encoded = jpegJs.encode({ data, width, height }, 80);
  return Buffer.from(
    encoded.data instanceof Uint8Array
      ? encoded.data
      : new Uint8Array(encoded.data),
  );
}

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

  const jpeg = jpegBytes(64, 48);
  const form = new FormData();
  form.set("file", new File([jpeg], "smoke.jpg", { type: "image/jpeg" }));
  form.set("conv_id", "group:wild");
  const uploaded = await fetch(`${runtime.httpUrl}/api/posts/images`, {
    method: "POST",
    headers: { Authorization: `Bearer ${runtime.token}` },
    body: form,
  });
  if (!uploaded.ok) {
    throw new Error(`image upload failed: ${uploaded.status} ${await uploaded.text()}`);
  }
  assert.equal(uploaded.status, 201);
  const uploadedBody = (await uploaded.json()) as {
    post?: { id: string; type: string; image_id?: string };
  };
  assert.equal(uploadedBody.post?.type, "image");
  assert.ok(uploadedBody.post?.image_id);

  const afterUpload = await runtime.client.expectOk("fetchPostsAction", [
    { type: "conversation", conv_id: "group:wild", limit: "20" },
  ]);
  const imagePost = afterUpload.posts.find(
    (post) => post.id === uploadedBody.post?.id,
  );
  assert.ok(imagePost);
  assert.equal(isImagePost(imagePost), true);
  if (!isImagePost(imagePost)) return;

  const thumb = await fetch(
    `${runtime.httpUrl}/api/posts/images/${encodeURIComponent(imagePost.image_id)}/thumb`,
    { headers: { Authorization: `Bearer ${runtime.token}` } },
  );
  if (!thumb.ok) {
    throw new Error(`thumb fetch failed: ${thumb.status} ${await thumb.text()}`);
  }
  assert.equal(thumb.headers.get("content-type"), "image/jpeg");
  const thumbBytes = Buffer.from(await thumb.arrayBuffer());
  assert.ok(thumbBytes.byteLength > 0);

  const original = await fetch(
    `${runtime.httpUrl}/api/posts/images/${encodeURIComponent(imagePost.image_id)}/original`,
    { headers: { Authorization: `Bearer ${runtime.token}` } },
  );
  if (!original.ok) {
    throw new Error(
      `original fetch failed: ${original.status} ${await original.text()}`,
    );
  }
  assert.equal(original.headers.get("content-type"), "image/jpeg");
  const originalBytes = Buffer.from(await original.arrayBuffer());
  assert.equal(originalBytes.byteLength, jpeg.byteLength);

  const deleted = await runtime.client.expectOk("deletePostAction", [
    created.post.id,
  ]);
  assert.equal(deleted.post.id, created.post.id);
}
