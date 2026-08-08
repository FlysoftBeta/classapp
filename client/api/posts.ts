import type { Conversation, Post } from "@/shared/types/api";
import type { CreatePostPayload } from "@/shared/validation/posts";
import { observeActionResult } from "./runtime";
const {
  createPostAction,
  deletePostAction,
  fetchPostAction,
  fetchPostsAction,
  updatePostAction,
} = client.actions;
import { client } from "@/client/lib/remote/client";
import { offlineRepository } from "@/client/data/repository";

export type PostMutationData = {
  post?: Post;
  error?: string;
};

export type PostDeleteData = {
  post?: Post;
  error?: string;
};

export async function fetchCachedPosts(
  conv: Pick<Conversation, "type" | "id" | "conv_id">,
  params: Record<string, string>,
) {
  const cached = await offlineRepository.getPosts(conv);
  const limit = Math.max(1, Number(params.limit) || 50);
  let posts = cached;
  if (params.before_id) {
    const index = cached.findIndex((post) => post.id === params.before_id);
    posts = cached.slice(0, index < 0 ? cached.length : index);
  } else if (params.after_id) {
    const index = cached.findIndex((post) => post.id === params.after_id);
    return {
      posts: cached.slice(
        index < 0 ? cached.length : index + 1,
        index < 0 ? undefined : index + 1 + limit,
      ),
    };
  }
  return { posts: posts.slice(-limit).reverse() };
}

function buildPostsSearchParams(
  conv: Pick<Conversation, "type" | "id" | "conv_id">,
  params: Record<string, string>,
) {
  const sp = new URLSearchParams(params);
  sp.set("type", "conversation");
  sp.set("conv_id", conv.conv_id);
  return sp;
}

export async function fetchPosts(
  conv: Pick<Conversation, "type" | "id" | "conv_id">,
  params: Record<string, string>,
) {
  if (!client.isConnected()) return fetchCachedPosts(conv, params);
  return fetchRemotePosts(conv, params);
}

/** Always reads the authoritative server; callers use this for revalidation. */
export async function fetchRemotePosts(
  conv: Pick<Conversation, "type" | "id" | "conv_id">,
  params: Record<string, string>,
) {
  const searchParams = buildPostsSearchParams(conv, params);
  const result = await fetchPostsAction({
    type:
      (searchParams.get("type") as "feed" | "conversation" | null) ?? undefined,
    conv_id: searchParams.get("conv_id") ?? undefined,
    before_id: searchParams.get("before_id") ?? undefined,
    after_id: searchParams.get("after_id") ?? undefined,
    before_sequence: searchParams.has("before_sequence")
      ? Number(searchParams.get("before_sequence"))
      : undefined,
    after_sequence: searchParams.has("after_sequence")
      ? Number(searchParams.get("after_sequence"))
      : undefined,
    changed_after_revision: searchParams.has("changed_after_revision")
      ? Number(searchParams.get("changed_after_revision"))
      : undefined,
    changed_through_revision: searchParams.has("changed_through_revision")
      ? Number(searchParams.get("changed_through_revision"))
      : undefined,
    limit: searchParams.get("limit") ?? undefined,
    offset: searchParams.get("offset") ?? undefined,
  });
  observeActionResult(result);
  if (!result.ok) return null;
  const data = result.data;
  if (data.posts?.length) {
    if (params.changed_after_revision) {
      await offlineRepository.savePosts(conv, data.posts);
    } else {
      await offlineRepository.reconcilePostPage(conv, data.posts);
    }
  }
  return data;
}

export async function fetchPost(postId: string) {
  const result = await fetchPostAction(postId);
  const res = observeActionResult(result);
  const data: PostMutationData = result.ok
    ? result.data
    : { error: result.error.message };
  return { res, data };
}

export type CreatePostBody = {
  content?: CreatePostPayload | string;
  conv_id: string;
  reply_to?: string;
};

export async function createPost(body: CreatePostBody) {
  const result = await createPostAction(body);
  const res = observeActionResult(result);
  const data: PostMutationData = result.ok
    ? result.data
    : { error: result.error.message };
  return { res, data };
}

export async function updatePost(postId: string, text: string) {
  const result = await updatePostAction({ postId, text });
  const res = observeActionResult(result);
  const data: PostMutationData = result.ok
    ? result.data
    : { error: result.error.message };
  return { res, data };
}

export async function deletePost(postId: string) {
  const result = await deletePostAction(postId);
  const res = observeActionResult(result);
  const data: PostDeleteData = result.ok
    ? result.data
    : { error: result.error.message };
  return { res, data };
}
