import { parsePagination } from "@/server/validation/pagination";
import { isCreatePostPayload } from "@/shared/validation/posts";
import { withActionSession, expectString } from "./_base";
import type { ActionInput } from "@/shared/protocol/actions";

export async function fetchPostsAction(input: ActionInput<"fetchPostsAction">) {
  return withActionSession(async (session) => {
    const { limit, offset } = parsePagination(input.limit, input.offset);
    return {
      posts: await (
        await (await session.asActor()).posts()
      ).list({
        type: input.type ?? "feed",
        conv_id: input.conv_id,
        before_id: input.before_id ?? "",
        after_id: input.after_id ?? "",
        before_sequence: input.before_sequence,
        after_sequence: input.after_sequence,
        changed_after_revision: input.changed_after_revision,
        changed_through_revision: input.changed_through_revision,
        limit,
        offset,
      }),
    };
  });
}

export async function fetchPostAction(postId: ActionInput<"fetchPostAction">) {
  return withActionSession(async (session) => {
    return {
      post: await (await (await session.asActor()).posts()).get(postId),
    };
  });
}

export async function createPostAction(input: ActionInput<"createPostAction">) {
  return withActionSession(async (session) => {
    const content =
      typeof input.content === "string" || isCreatePostPayload(input.content)
        ? input.content
        : undefined;
    return {
      post: await (
        await (await session.asActor()).posts()
      ).create({
        content,
        conv_id: input.conv_id,
        reply_to: input.reply_to,
      }),
    };
  });
}

export async function updatePostAction(input: ActionInput<"updatePostAction">) {
  return withActionSession(async (session) => {
    return {
      post: await (
        await (await session.asActor()).posts()
      ).update(
        expectString(input.postId, "帖子不存在"),
        expectString(input.text, "文本不能为空", { trim: false }),
      ),
    };
  });
}

export async function deletePostAction(
  postId: ActionInput<"deletePostAction">,
) {
  return withActionSession(async (session) => {
    const post = await (
      await (await session.asActor()).posts()
    ).softDelete(expectString(postId, "帖子不存在"));
    return { post };
  });
}
