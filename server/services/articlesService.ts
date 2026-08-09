import crypto from "crypto";
import type { Database } from "better-sqlite3";
import type {
  Article,
  ArticleSidebarPayload,
  ArticleWithMeta,
  User,
} from "@/shared/types/api";
import type {
  ArticleListUpdatedPayload,
  ArticleSidebarUpdatedPayload,
} from "@/shared/types/events";
import { USER_CONFIG } from "@/shared/userConfig/keys";
import {
  addArticleProgressSeconds,
  deleteArticleById,
  findArticleForUser,
  findArticleRecord,
  getArticleTextSegment,
  insertBundleArticle,
  insertTextArticle,
  listArticleHistoryRows,
  listArticlesForUser,
  listBookmarkedArticleRows,
  rowToArticle,
  setArticleBookmarkValue,
  touchArticleProgress,
  upsertArticleProgressOffset,
  purgeArticlesForUser,
} from "@/server/data/articles";
import { CheckedError, MalformedRequestError } from "@/shared/protocol/errors";
import { publishGroupArticle, publishUser } from "@/server/services/eventBus";
import {
  deleteUserConfig,
  getUserConfig,
  setUserConfig,
} from "@/server/services/userConfig";
import {
  assertCanAccessArticle,
  assertCanCreateArticle,
  assertCanDeleteArticle,
} from "@/server/domain/policy/articles";
import { removeArticleBundle } from "@/server/infra/articleArtifacts";
import { READING_HISTORY_MIN_SECONDS } from "@/shared/types/api/article";
import { assertGroupMember } from "@/server/domain/policy/membership";
import type { BundleSlice } from "@/shared/bundles/protocol";
import {
  loadRenderArchive,
  type RenderArchiveIndex,
} from "@/server/infra/renderArchive";

export interface CreateArticleInput {
  title: string;
  content: string;
  group_id: string;
}
export interface CreateBundleArticleInput {
  title: string;
  source_path: string;
  archive_path: string;
  source_mime: string;
  source_size: number;
  archive_size: number;
  original_filename: string;
  item_count: number;
  group_id: string;
}

function requireTrimmed(value: string, message: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new MalformedRequestError(message);
  return trimmed;
}

export class ArticleService {
  constructor(private readonly db: Database) {}

  list(
    user: User,
    input: {
      view?: "all" | "bookmarked" | "recent";
      cursor?: { sortAt: string; id: string };
      direction?: "before" | "after";
      groupId?: string;
    },
  ) {
    if (input.groupId) assertGroupMember(this.db, user.id, input.groupId);
    return listArticlesForUser(this.db, user.id, input);
  }

  sidebar(user: User): ArticleSidebarPayload {
    const currentArticleId = getUserConfig(
      this.db,
      user.id,
      USER_CONFIG.ACTIVE_ARTICLE_ID,
    );
    const byId = new Map<string, Article & ArticleWithMeta>();
    for (const row of listBookmarkedArticleRows(this.db, user.id))
      byId.set(row.id as string, rowToArticle(row));
    for (const row of listArticleHistoryRows(this.db, user.id))
      byId.set(row.id as string, rowToArticle(row));
    if (currentArticleId) {
      const active = findArticleForUser(this.db, currentArticleId, user.id);
      if (active) byId.set(active.id, active);
    }
    const articles = [...byId.values()].sort((a, b) =>
      (b.last_read_at ?? b.created_at).localeCompare(
        a.last_read_at ?? a.created_at,
      ),
    );
    return { current_article_id: currentArticleId, articles };
  }

  createText(
    user: User,
    input: CreateArticleInput,
  ): { article: Article & ArticleWithMeta } {
    assertCanCreateArticle(this.db, user, input.group_id);
    const article = this.insertText(
      user.id,
      requireTrimmed(input.title, "标题不能为空"),
      requireTrimmed(input.content, "内容不能为空"),
      input.group_id,
    );
    this.notifyCreated(user.id, article.id);
    return { article };
  }

  createBundle(
    user: User,
    input: CreateBundleArticleInput,
  ): { article: Article & ArticleWithMeta } {
    assertCanCreateArticle(this.db, user, input.group_id);
    if (!input.source_path || !input.archive_path)
      throw new MalformedRequestError("文件保存失败");
    if (input.source_mime !== "application/pdf")
      throw new MalformedRequestError("仅支持 PDF 文件");
    const id = crypto.randomUUID();
    insertBundleArticle(this.db, {
      id,
      userId: user.id,
      title: requireTrimmed(input.title, "标题不能为空"),
      sourcePath: input.source_path,
      archivePath: input.archive_path,
      sourceMime: input.source_mime,
      sourceSize: input.source_size,
      archiveSize: input.archive_size,
      originalFilename: input.original_filename,
      itemCount: input.item_count,
      groupId: input.group_id,
    });
    const article = this.requireOwned(id, user.id);
    this.notifyCreated(user.id, id);
    return { article };
  }

  getMeta(
    user: User,
    articleId: string,
  ): { article: Omit<ArticleWithMeta, "content"> } {
    assertCanAccessArticle(this.db, user, articleId);
    const article = findArticleForUser(this.db, articleId, user.id);
    if (!article) throw new CheckedError("NOT_FOUND", "文章不存在", 404);
    const { content: _content, ...meta } = article;
    void _content;
    return { article: meta };
  }

  segment(user: User, input: { articleId: string; offset: number }) {
    assertCanAccessArticle(this.db, user, input.articleId);
    const segment = getArticleTextSegment(
      this.db,
      input.articleId,
      input.offset,
    );
    if (!segment) throw new CheckedError("NOT_FOUND", "文章不存在", 404);
    if (segment.content_kind === "bundle")
      throw new MalformedRequestError("二进制文章不支持文本分段");
    return {
      content: segment.content,
      offset: segment.clamped_offset,
      has_more: segment.has_more,
      content_length: segment.content_length,
    };
  }

  async openBundle(
    user: User,
    input: {
      articleId: string;
      cursor: number | null;
      before: number;
      after: number;
    },
  ): Promise<BundleSlice> {
    const index = await this.requireBundle(user, input.articleId);
    if (!index.items.length) return this.sliceBundle(index, 0, 0);
    const cursor = Math.min(input.cursor ?? 0, index.items.length - 1);
    return this.sliceBundle(
      index,
      Math.max(0, cursor - input.before),
      Math.min(index.items.length, cursor + input.after + 1),
    );
  }

  async fetchBundle(
    user: User,
    input: {
      articleId: string;
      cursor: number;
      direction: "before" | "after";
      limit: number;
    },
  ): Promise<BundleSlice> {
    const index = await this.requireBundle(user, input.articleId);
    if (input.direction === "before") {
      const end = Math.min(input.cursor, index.items.length);
      return this.sliceBundle(index, Math.max(0, end - input.limit), end);
    }
    const start = Math.min(input.cursor + 1, index.items.length);
    return this.sliceBundle(
      index,
      start,
      Math.min(index.items.length, start + input.limit),
    );
  }

  setBookmark(
    user: User,
    articleId: string,
    bookmarked: boolean,
    updatedAt: number,
  ) {
    assertCanAccessArticle(this.db, user, articleId);
    const value = setArticleBookmarkValue(
      this.db,
      user.id,
      articleId,
      bookmarked,
      updatedAt,
    );
    this.publishSidebar(user.id, articleId);
    this.publishList(user.id, articleId);
    return value;
  }

  saveProgress(
    user: User,
    articleId: string,
    offset: number,
    updatedAt: number,
    merge: "override" | "furthest",
  ) {
    assertCanAccessArticle(this.db, user, articleId);
    const article = findArticleRecord(this.db, articleId);
    if (!article) throw new CheckedError("NOT_FOUND", "文章不存在", 404);
    const safe =
      article.content_kind === "bundle"
        ? Math.max(
            0,
            Math.min(
              Math.floor(offset),
              Math.max(0, article.content_length - 1),
            ),
          )
        : Math.max(0, Math.min(Math.floor(offset), article.content_length));
    const value = upsertArticleProgressOffset(
      this.db,
      user.id,
      articleId,
      safe,
      updatedAt,
      merge,
    );
    this.publishReading(user.id, articleId);
    return value;
  }

  recordReading(
    user: User,
    articleId: string,
    input: { seconds?: number; active?: boolean },
  ): void {
    assertCanAccessArticle(this.db, user, articleId);
    const seconds = Math.max(0, Math.min(Math.floor(input.seconds ?? 0), 300));
    if (seconds)
      addArticleProgressSeconds(this.db, user.id, articleId, seconds);
    else touchArticleProgress(this.db, user.id, articleId);
    if (input.active)
      setUserConfig(this.db, user.id, USER_CONFIG.ACTIVE_ARTICLE_ID, articleId);
    else if (
      getUserConfig(this.db, user.id, USER_CONFIG.ACTIVE_ARTICLE_ID) ===
      articleId
    )
      deleteUserConfig(this.db, user.id, USER_CONFIG.ACTIVE_ARTICLE_ID);
    this.publishReading(user.id, articleId);
  }

  async delete(user: User, articleId: string): Promise<void> {
    assertCanDeleteArticle(this.db, user, articleId);
    const record = findArticleRecord(this.db, articleId);
    deleteArticleById(this.db, articleId);
    if (record?.content_kind === "bundle")
      await removeArticleBundle(record.source_path, record.archive_path);
    const affectedUsers = new Set(
      [user.id, record?.user_id].filter((id): id is string => !!id),
    );
    for (const userId of affectedUsers) {
      if (
        getUserConfig(this.db, userId, USER_CONFIG.ACTIVE_ARTICLE_ID) ===
        articleId
      ) {
        deleteUserConfig(this.db, userId, USER_CONFIG.ACTIVE_ARTICLE_ID);
      }
      publishUser(userId, {
        kind: "article.sidebar_updated",
        data: {
          removed: { article_id: articleId },
          current_article_id: getUserConfig(
            this.db,
            userId,
            USER_CONFIG.ACTIVE_ARTICLE_ID,
          ),
        },
      });
      publishUser(userId, {
        kind: "article.list_updated",
        data: { removed: { article_id: articleId } },
      });
    }
    if (record?.group_id) {
      publishGroupArticle(record.group_id, {
        kind: "article.list_updated",
        data: { refresh: true },
      });
    }
  }

  async purgeUser(userId: string): Promise<void> {
    for (const artifact of purgeArticlesForUser(this.db, userId)) {
      await removeArticleBundle(artifact.sourcePath, artifact.archivePath);
    }
  }

  private insertText(
    userId: string,
    title: string,
    content: string,
    groupId: string,
  ) {
    const id = crypto.randomUUID();
    insertTextArticle(this.db, { id, userId, groupId, title, content });
    return this.requireOwned(id, userId);
  }

  private async requireBundle(
    user: User,
    articleId: string,
  ): Promise<RenderArchiveIndex> {
    assertCanAccessArticle(this.db, user, articleId);
    const article = findArticleRecord(this.db, articleId);
    if (
      !article ||
      article.content_kind !== "bundle" ||
      !article.archive_path
    ) {
      throw new CheckedError("NOT_FOUND", "文档资源不存在", 404);
    }
    return loadRenderArchive(article.archive_path);
  }

  private sliceBundle(
    index: RenderArchiveIndex,
    start: number,
    end: number,
  ): BundleSlice {
    const items = index.items.slice(start, end);
    const ids = new Set(index.header.shared);
    if (index.header.dictionary) ids.add(index.header.dictionary.content_id);
    for (const item of items) {
      ids.add(item.document);
      for (const dependency of item.dependencies) ids.add(dependency);
    }
    return {
      header: index.header,
      items,
      resources: [...ids].map((id) => {
        const resource = index.resources.get(id);
        if (!resource) throw new Error(`Bundle resource ${id} is not indexed`);
        const { storedOffset: _storedOffset, ...publicResource } = resource;
        void _storedOffset;
        return publicResource;
      }),
      exhausted_before: start === 0,
      exhausted_after: end >= index.items.length,
    };
  }
  private requireOwned(id: string, userId: string) {
    const article = findArticleForUser(this.db, id, userId);
    if (!article) throw new CheckedError("NOT_FOUND", "文章不存在", 404);
    return article;
  }
  private notifyCreated(userId: string, articleId: string) {
    this.publishList(userId, articleId, true);
    const article = findArticleRecord(this.db, articleId);
    if (!article) throw new CheckedError("NOT_FOUND", "文章不存在", 404);
    publishGroupArticle(article.group_id, {
      kind: "article.list_updated",
      data: { refresh: true },
    });
  }
  private publishReading(userId: string, articleId: string) {
    this.publishSidebar(userId, articleId);
    this.publishList(userId, articleId);
  }
  private publishSidebar(userId: string, articleId: string) {
    const entry = findArticleForUser(this.db, articleId, userId);
    const current = getUserConfig(
      this.db,
      userId,
      USER_CONFIG.ACTIVE_ARTICLE_ID,
    );
    const visible =
      entry &&
      (entry.is_bookmarked ||
        current === articleId ||
        (entry.total_read_seconds ?? 0) >= READING_HISTORY_MIN_SECONDS);
    const data: ArticleSidebarUpdatedPayload = visible
      ? { entry, current_article_id: current }
      : { removed: { article_id: articleId }, current_article_id: current };
    publishUser(userId, { kind: "article.sidebar_updated", data });
  }
  private publishList(userId: string, articleId: string, created = false) {
    const entry = findArticleForUser(this.db, articleId, userId);
    const data: ArticleListUpdatedPayload = entry
      ? { entry, ...(created ? { created: true } : {}) }
      : { removed: { article_id: articleId } };
    publishUser(userId, { kind: "article.list_updated", data });
  }
}

export function createArticleService(db: Database): ArticleService {
  return new ArticleService(db);
}
