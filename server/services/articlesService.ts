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
  insertBlobArticle,
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
import { removeArticleBlob } from "@/server/infra/articleBlobs";
import { READING_HISTORY_MIN_SECONDS } from "@/shared/types/api/article";
import { assertGroupMember } from "@/server/domain/policy/membership";

export interface CreateArticleInput {
  title: string;
  content: string;
  group_id: string;
}
export interface CreateBlobArticleInput {
  title: string;
  blob_path: string;
  mime_type: string;
  file_size: number;
  original_filename: string;
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

  createBlob(
    user: User,
    input: CreateBlobArticleInput,
  ): { article: Article & ArticleWithMeta } {
    assertCanCreateArticle(this.db, user, input.group_id);
    if (!input.blob_path) throw new MalformedRequestError("文件保存失败");
    if (input.mime_type !== "application/pdf")
      throw new MalformedRequestError("仅支持 PDF 文件");
    const id = crypto.randomUUID();
    insertBlobArticle(this.db, {
      id,
      userId: user.id,
      title: requireTrimmed(input.title, "标题不能为空"),
      blobPath: input.blob_path,
      mimeType: input.mime_type,
      fileSize: input.file_size,
      originalFilename: input.original_filename,
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
    if (segment.content_kind === "blob")
      throw new MalformedRequestError("二进制文章不支持文本分段");
    return {
      content: segment.content,
      offset: segment.clamped_offset,
      has_more: segment.has_more,
      content_length: segment.content_length,
    };
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
  ) {
    assertCanAccessArticle(this.db, user, articleId);
    const article = findArticleRecord(this.db, articleId);
    if (!article) throw new CheckedError("NOT_FOUND", "文章不存在", 404);
    const safe =
      article.content_kind === "blob"
        ? Math.max(0, Math.floor(offset))
        : Math.max(0, Math.min(Math.floor(offset), article.content_length));
    const value = upsertArticleProgressOffset(
      this.db,
      user.id,
      articleId,
      safe,
      updatedAt,
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
    if (record?.content_kind === "blob" && record.blob_path)
      await removeArticleBlob(record.blob_path);
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
    for (const blobPath of purgeArticlesForUser(this.db, userId)) {
      await removeArticleBlob(blobPath);
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
