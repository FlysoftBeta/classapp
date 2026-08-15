import { withActionScope, expectString } from "./_base";
import { ContractViolationError } from "@/server/services/incidentService";
import type { ActionInput } from "@/shared/protocol/actions";

export async function listArticlesAction(
  input: ActionInput<"listArticlesAction">,
) {
  return withActionScope(async (scope) => {
    return scope.facades().articles().list({
      view: input.view,
      cursor: input.cursor,
      direction: input.direction,
      groupId: input.group_id,
    });
  });
}

export async function fetchArticleSidebarAction() {
  return withActionScope(async (scope) => {
    return scope.facades().articles().sidebar();
  });
}

export async function createArticleAction(
  input: ActionInput<"createArticleAction">,
) {
  return withActionScope(async (scope) => {
    return scope.facades().articles().createText(input);
  });
}

export async function fetchArticleAction(
  articleId: ActionInput<"fetchArticleAction">,
) {
  return withActionScope(async (scope) => {
    return scope.facades().articles().getMeta(articleId);
  });
}

export async function fetchArticleSegmentAction(
  input: ActionInput<"fetchArticleSegmentAction">,
) {
  return withActionScope(async (scope) => {
    return scope.facades().articles().segment({
      articleId: input.articleId,
      offset: input.offset,
    });
  });
}

export async function openArticleBundleAction(
  input: ActionInput<"openArticleBundleAction">,
) {
  return withActionScope(async (scope) => {
    return scope.facades().articles().openBundle(input);
  });
}

export async function fetchArticleBundleItemsAction(
  input: ActionInput<"fetchArticleBundleItemsAction">,
) {
  return withActionScope(async (scope) => {
    return scope.facades().articles().fetchBundle(input);
  });
}

export async function setArticleBookmarkAction(
  input: ActionInput<"setArticleBookmarkAction">,
) {
  return withActionScope(async (scope) => {
    if (!Number.isSafeInteger(input.updatedAt) || input.updatedAt < 0) {
      throw new ContractViolationError("书签时间戳无效");
    }
    return await scope
      .facades()
      .articles()
      .setBookmark(input.articleId, input.bookmarked, input.updatedAt);
  });
}

export async function saveArticleProgressAction(
  input: ActionInput<"saveArticleProgressAction">,
) {
  return withActionScope(async (scope) => {
    if (!Number.isSafeInteger(input.updatedAt) || input.updatedAt < 0) {
      throw new ContractViolationError("阅读进度时间戳无效");
    }
    return await scope
      .facades()
      .articles()
      .saveProgress(
        input.articleId,
        input.offset,
        input.updatedAt,
        input.merge,
      );
  });
}

export async function reportArticleReadingAction(
  input: ActionInput<"reportArticleReadingAction">,
) {
  return withActionScope(async (scope) => {
    await scope.facades().articles().recordReading(input.articleId, {
      seconds: input.seconds,
      active: input.active,
    });
    return { ok: true as const };
  });
}

export async function deleteArticleAction(
  articleId: ActionInput<"deleteArticleAction">,
) {
  return withActionScope(async (scope) => {
    await scope
      .facades()
      .articles()
      .delete(expectString(articleId, "文章不存在"));
    return { ok: true as const };
  });
}

export async function searchNetworkArticlesAction(
  input: ActionInput<"searchNetworkArticlesAction">,
) {
  return withActionScope(async (scope) =>
    scope.facades().articles().searchNetwork(input.query),
  );
}

export async function startNetworkArticleDownloadAction(
  input: ActionInput<"startNetworkArticleDownloadAction">,
) {
  return withActionScope(async (scope) =>
    scope
      .facades()
      .articles()
      .startNetworkDownload(input.book_id, input.group_id, input.title),
  );
}

export async function listNetworkArticleDownloadsAction() {
  return withActionScope(async (scope) =>
    scope.facades().articles().listNetworkDownloads(),
  );
}
