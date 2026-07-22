import { parseOffset } from "@/server/validation/pagination";
import { withActionSession, expectString } from "./_base";
import { MalformedRequestError } from "@/shared/protocol/errors";
import type { ActionInput } from "@/shared/protocol/actions";

export async function listArticlesAction(
  input: ActionInput<"listArticlesAction">,
) {
  return withActionSession(async (session) => {
    return (await (await session.asActor()).articles()).list({
      bookmarkedOnly: input.bookmarked === true,
      offset: parseOffset(
        input.offset === undefined ? null : String(input.offset),
      ),
    });
  });
}

export async function fetchArticleSidebarAction() {
  return withActionSession(async (session) => {
    return (await (await session.asActor()).articles()).sidebar();
  });
}

export async function createArticleAction(
  input: ActionInput<"createArticleAction">,
) {
  return withActionSession(async (session) => {
    return (await (await session.asActor()).articles()).createText(input);
  });
}

export async function fetchArticleAction(
  articleId: ActionInput<"fetchArticleAction">,
) {
  return withActionSession(async (session) => {
    return (await (await session.asActor()).articles()).getMeta(articleId);
  });
}

export async function fetchArticleSegmentAction(
  input: ActionInput<"fetchArticleSegmentAction">,
) {
  return withActionSession(async (session) => {
    return (await (await session.asActor()).articles()).segment({
      articleId: input.articleId,
      offset: input.offset,
    });
  });
}

export async function setArticleBookmarkAction(
  input: ActionInput<"setArticleBookmarkAction">,
) {
  return withActionSession(async (session) => {
    if (!Number.isSafeInteger(input.updatedAt) || input.updatedAt < 0) {
      throw new MalformedRequestError("书签时间戳无效");
    }
    return await (
      await (await session.asActor()).articles()
    ).setBookmark(input.articleId, input.bookmarked, input.updatedAt);
  });
}

export async function saveArticleProgressAction(
  input: ActionInput<"saveArticleProgressAction">,
) {
  return withActionSession(async (session) => {
    if (!Number.isSafeInteger(input.updatedAt) || input.updatedAt < 0) {
      throw new MalformedRequestError("阅读进度时间戳无效");
    }
    return await (
      await (await session.asActor()).articles()
    ).saveProgress(input.articleId, input.offset, input.updatedAt);
  });
}

export async function reportArticleReadingAction(
  input: ActionInput<"reportArticleReadingAction">,
) {
  return withActionSession(async (session) => {
    await (
      await (await session.asActor()).articles()
    ).recordReading(input.articleId, {
      seconds: input.seconds,
      active: input.active,
    });
    return { ok: true as const };
  });
}

export async function deleteArticleAction(
  articleId: ActionInput<"deleteArticleAction">,
) {
  return withActionSession(async (session) => {
    await (
      await (await session.asActor()).articles()
    ).delete(expectString(articleId, "文章不存在"));
    return { ok: true as const };
  });
}

export async function searchNetworkArticlesAction(
  input: ActionInput<"searchNetworkArticlesAction">,
) {
  return withActionSession(async (session) =>
    (await (await session.asActor()).articles()).searchNetwork(input.query),
  );
}

export async function startNetworkArticleDownloadAction(
  input: ActionInput<"startNetworkArticleDownloadAction">,
) {
  return withActionSession(async (session) =>
    (await (await session.asActor()).articles()).startNetworkDownload(
      input.book_id,
      input.title,
    ),
  );
}

export async function listNetworkArticleDownloadsAction() {
  return withActionSession(async (session) =>
    (await (await session.asActor()).articles()).listNetworkDownloads(),
  );
}
