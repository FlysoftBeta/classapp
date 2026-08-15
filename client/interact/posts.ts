import type { PostEntity, UserMetadata } from "@/shared/types/api";
import type { Conversation, Post } from "@/client/interact/presentation";
import type { CreatePostPayload } from "@/shared/validation/posts";
import { observeActionResult } from "@/client/api/runtime";
const {
  createPostAction,
  deletePostAction,
  fetchPostAction,
  fetchPostsAction,
  updatePostAction,
} = client.actions;
import { client } from "@/client/interact/remote/client";
import { currentActorRepository as offlineRepository } from "@/client/interact/actorContext";
import { captureDetachedClientIncident } from "@/client/interact/clientIncidents";

export type PostMutationData = {
  post?: Post;
  users?: UserMetadata[];
  error?: string;
};

export type PostDeleteData = {
  post?: Post;
  users?: UserMetadata[];
  error?: string;
};

export function materializePost(
  post: PostEntity,
  users: readonly UserMetadata[],
): Post {
  const byId = new Map(users.map((user) => [user.id, user]));
  const author = post.user_id ? byId.get(post.user_id) : undefined;
  const replyAuthor = post.reply_user_id
    ? byId.get(post.reply_user_id)
    : undefined;
  return {
    ...post,
    username: author?.username ?? null,
    handle: author?.handle ?? null,
    reply_username: replyAuthor?.username ?? null,
    reply_handle: replyAuthor?.handle ?? null,
  };
}

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

export async function findCachedPost(
  conv: Pick<Conversation, "type" | "id" | "conv_id">,
  postId: string,
): Promise<Post | null> {
  return (
    (await offlineRepository.getPosts(conv)).find(
      (post) => post.id === postId,
    ) ?? null
  );
}

export async function locateCachedPost(
  conv: Pick<Conversation, "type" | "id" | "conv_id">,
  sequence: number,
): Promise<Post | null> {
  return (await offlineRepository.getPosts(conv)).reduce<Post | null>(
    (nearest, post) => {
      if (!nearest) return post;
      return Math.abs(post.sequence - sequence) <
        Math.abs(nearest.sequence - sequence)
        ? post
        : nearest;
    },
    null,
  );
}

export async function resolvePost(
  conv: Pick<Conversation, "type" | "id" | "conv_id">,
  postId: string,
  authoritative = false,
): Promise<Post | null> {
  const cached = await findCachedPost(conv, postId);
  if (!authoritative && cached) return cached;
  if (!client.isConnected()) return cached;
  const { data } = await fetchPost(postId);
  return "post" in data && data.post ? data.post : null;
}

export async function locatePost(
  conv: Pick<Conversation, "type" | "id" | "conv_id">,
  sequence: number,
): Promise<Post | null> {
  if (!client.isConnected()) return locateCachedPost(conv, sequence);
  const data = await fetchPosts(conv, {
    limit: "1",
    before_id: "__infini_sequence_cursor__",
    before_sequence: String(sequence + 1),
  });
  return data?.posts?.[0] ?? null;
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
  conv: Pick<Conversation, "type" | "id" | "conv_id"> &
    Partial<Pick<Conversation, "revision">>,
  params: Record<string, string>,
) {
  if (!client.isConnected()) return fetchCachedPosts(conv, params);
  return fetchRemotePosts(conv, params);
}

/** Always reads the authoritative server; callers use this for revalidation. */
export async function fetchRemotePosts(
  conv: Pick<Conversation, "type" | "id" | "conv_id"> &
    Partial<Pick<Conversation, "revision">>,
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
  try {
    await offlineRepository.saveUserMetadata(data.users);
    if (data.posts?.length) {
      if (params.changed_after_revision) {
        // Revision pages contain changed rows, not a contiguous history page.
        await offlineRepository.savePosts(conv, data.posts, {
          extendCoverage: false,
        });
      } else {
        const limit = Math.max(1, Number(params.limit) || 50);
        await offlineRepository.reconcilePostPage(conv, data.posts, {
          ...(params.before_id ? { beforeId: params.before_id } : {}),
          ...(params.after_id ? { afterId: params.after_id } : {}),
          exhausted: data.posts.length < limit,
        });
      }
    }
    if (!params.changed_after_revision && conv.revision !== undefined) {
      await offlineRepository.advancePostRevision(conv.conv_id, conv.revision);
    }
  } catch (error) {
    // Post rows remain usable even if their evictable projection cannot commit.
    captureDetachedClientIncident("post.page-cache", error);
  }
  return {
    ...data,
    posts: data.posts.map((post) => materializePost(post, data.users)),
  };
}

export function commitPostRevisionRange(
  conv: Pick<Conversation, "type" | "id" | "conv_id">,
  posts: Post[],
  revision: number,
  revisionSum?: string,
) {
  return offlineRepository.reconcilePostRevisions(
    conv,
    posts,
    revision,
    revisionSum,
  );
}

export async function fetchPost(postId: string) {
  const result = await fetchPostAction(postId);
  const res = observeActionResult(result);
  if (result.ok) await offlineRepository.saveUserMetadata(result.data.users);
  const data: PostMutationData = result.ok
    ? {
        ...result.data,
        post: materializePost(result.data.post, result.data.users),
      }
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
  if (result.ok) await offlineRepository.saveUserMetadata(result.data.users);
  const data: PostMutationData = result.ok
    ? {
        ...result.data,
        post: materializePost(result.data.post, result.data.users),
      }
    : { error: result.error.message };
  return { res, data };
}

export async function updatePost(postId: string, text: string) {
  const result = await updatePostAction({ postId, text });
  const res = observeActionResult(result);
  if (result.ok) await offlineRepository.saveUserMetadata(result.data.users);
  const data: PostMutationData = result.ok
    ? {
        ...result.data,
        post: materializePost(result.data.post, result.data.users),
      }
    : { error: result.error.message };
  return { res, data };
}

export async function deletePost(postId: string) {
  const result = await deletePostAction(postId);
  const res = observeActionResult(result);
  if (result.ok) await offlineRepository.saveUserMetadata(result.data.users);
  const data: PostDeleteData = result.ok
    ? {
        ...result.data,
        post: materializePost(result.data.post, result.data.users),
      }
    : { error: result.error.message };
  return { res, data };
}
