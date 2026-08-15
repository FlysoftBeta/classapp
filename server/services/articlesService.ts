import crypto from "crypto";
import type { Database } from "better-sqlite3";
import type {
  ArticleSidebarPayload,
  ArticleWithMeta,
  UserMetadata,
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
  findArticleAccessRow,
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
import { userMetadataForIds } from "@/server/data/users";
import {
  PublicError,
  ContractViolationError,
} from "@/server/services/incidentService";
import { publishGroupArticle, publishUser } from "@/server/services/eventBus";
import {
  deleteUserConfig,
  getUserConfig,
  setUserConfig,
} from "@/server/services/userConfig";
import { removeArticleBundle } from "@/server/infra/articleArtifacts";
import { READING_HISTORY_MIN_SECONDS } from "@/shared/types/api/article";
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
  if (!trimmed) throw new ContractViolationError(message);
  return trimmed;
}

export class ArticleService {
  constructor(private readonly db: Database) {}

  list(
    userId: string,
    input: {
      view?: "all" | "bookmarked" | "recent";
      cursor?: { sortAt: string; id: string };
      direction?: "before" | "after";
      groupId?: string;
    },
  ) {
    const result = listArticlesForUser(this.db, userId, input);
    return {
      ...result,
      users: userMetadataForIds(
        this.db,
        result.articles.map((article) => article.user_id),
      ),
    };
  }

  sidebar(userId: string): ArticleSidebarPayload {
    const currentArticleId = getUserConfig(
      this.db,
      userId,
      USER_CONFIG.ACTIVE_ARTICLE_ID,
    );
    const byId = new Map<string, ArticleWithMeta>();
    for (const row of listBookmarkedArticleRows(this.db, userId))
      byId.set(row.id as string, rowToArticle(row));
    for (const row of listArticleHistoryRows(this.db, userId))
      byId.set(row.id as string, rowToArticle(row));
    if (currentArticleId) {
      const active = findArticleForUser(this.db, currentArticleId, userId);
      if (active) byId.set(active.id, active);
    }
    const articles = [...byId.values()].sort((a, b) =>
      (b.last_read_at ?? b.created_at).localeCompare(
        a.last_read_at ?? a.created_at,
      ),
    );
    return {
      current_article_id: currentArticleId,
      articles,
      users: userMetadataForIds(
        this.db,
        articles.map((article) => article.user_id),
      ),
    };
  }

  createText(
    userId: string,
    input: CreateArticleInput,
  ): { article: ArticleWithMeta; users: UserMetadata[] } {
    const article = this.insertText(
      userId,
      requireTrimmed(input.title, "标题不能为空"),
      requireTrimmed(input.content, "内容不能为空"),
      input.group_id,
    );
    this.notifyCreated(userId, article.id);
    return {
      article,
      users: userMetadataForIds(this.db, [article.user_id]),
    };
  }

  createBundle(
    userId: string,
    input: CreateBundleArticleInput,
  ): { article: ArticleWithMeta; users: UserMetadata[] } {
    if (!input.source_path || !input.archive_path)
      throw new ContractViolationError("文件保存失败");
    if (input.source_mime !== "application/pdf")
      throw new ContractViolationError("仅支持 PDF 文件");
    const id = crypto.randomUUID();
    insertBundleArticle(this.db, {
      id,
      userId,
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
    const article = this.requireOwned(id, userId);
    this.notifyCreated(userId, id);
    return {
      article,
      users: userMetadataForIds(this.db, [article.user_id]),
    };
  }

  getMeta(
    userId: string,
    articleId: string,
  ): { article: ArticleWithMeta; users: UserMetadata[] } {
    const article = findArticleForUser(this.db, articleId, userId);
    if (!article) throw new PublicError("文章不存在");
    return {
      article,
      users: userMetadataForIds(this.db, [article.user_id]),
    };
  }

  bundleResource(articleId: string) {
    const article = findArticleRecord(this.db, articleId);
    if (!article || article.content_kind !== "bundle") {
      throw new PublicError("文档资源不存在");
    }
    return article;
  }

  access(articleId: string) {
    const article = findArticleAccessRow(this.db, articleId);
    if (!article) throw new PublicError("文章不存在");
    return article;
  }

  segment(input: { articleId: string; offset: number }) {
    const segment = getArticleTextSegment(
      this.db,
      input.articleId,
      input.offset,
    );
    if (!segment) throw new PublicError("文章不存在");
    if (segment.content_kind === "bundle")
      throw new ContractViolationError("二进制文章不支持文本分段");
    return {
      content: segment.content,
      offset: segment.clamped_offset,
      has_more: segment.has_more,
      content_length: segment.content_length,
    };
  }

  async openBundle(input: {
    articleId: string;
    cursor: number | null;
    before: number;
    after: number;
  }): Promise<BundleSlice> {
    const index = await this.requireBundle(input.articleId);
    if (!index.items.length) return this.sliceBundle(index, 0, 0);
    const cursor = Math.min(input.cursor ?? 0, index.items.length - 1);
    return this.sliceBundle(
      index,
      Math.max(0, cursor - input.before),
      Math.min(index.items.length, cursor + input.after + 1),
    );
  }

  async fetchBundle(input: {
    articleId: string;
    cursor: number;
    direction: "before" | "after";
    limit: number;
  }): Promise<BundleSlice> {
    const index = await this.requireBundle(input.articleId);
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
    userId: string,
    articleId: string,
    bookmarked: boolean,
    updatedAt: number,
  ) {
    const value = setArticleBookmarkValue(
      this.db,
      userId,
      articleId,
      bookmarked,
      updatedAt,
    );
    this.publishSidebar(userId, articleId);
    this.publishList(userId, articleId);
    return value;
  }

  saveProgress(
    userId: string,
    articleId: string,
    offset: number,
    updatedAt: number,
    merge: "override" | "furthest",
  ) {
    const article = findArticleRecord(this.db, articleId);
    if (!article) throw new PublicError("文章不存在");
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
      userId,
      articleId,
      safe,
      updatedAt,
      merge,
    );
    this.publishReading(userId, articleId);
    return value;
  }

  recordReading(
    userId: string,
    articleId: string,
    input: { seconds?: number; active?: boolean },
  ): void {
    const seconds = Math.max(0, Math.min(Math.floor(input.seconds ?? 0), 300));
    if (seconds) addArticleProgressSeconds(this.db, userId, articleId, seconds);
    else touchArticleProgress(this.db, userId, articleId);
    if (input.active)
      setUserConfig(this.db, userId, USER_CONFIG.ACTIVE_ARTICLE_ID, articleId);
    else if (
      getUserConfig(this.db, userId, USER_CONFIG.ACTIVE_ARTICLE_ID) ===
      articleId
    )
      deleteUserConfig(this.db, userId, USER_CONFIG.ACTIVE_ARTICLE_ID);
    this.publishReading(userId, articleId);
  }

  async delete(requestingUserId: string, articleId: string): Promise<void> {
    const record = findArticleRecord(this.db, articleId);
    deleteArticleById(this.db, articleId);
    if (record?.content_kind === "bundle")
      await removeArticleBundle(record.source_path, record.archive_path);
    const affectedUsers = new Set(
      [requestingUserId, record?.user_id].filter((id): id is string => !!id),
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

  private async requireBundle(articleId: string): Promise<RenderArchiveIndex> {
    const article = findArticleRecord(this.db, articleId);
    if (
      !article ||
      article.content_kind !== "bundle" ||
      !article.archive_path
    ) {
      throw new PublicError("文档资源不存在");
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
    if (!article) throw new PublicError("文章不存在");
    return article;
  }
  private notifyCreated(userId: string, articleId: string) {
    this.publishList(userId, articleId, true);
    const article = findArticleRecord(this.db, articleId);
    if (!article) throw new PublicError("文章不存在");
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
      ? {
          entry,
          users: userMetadataForIds(this.db, [entry.user_id]),
          current_article_id: current,
        }
      : { removed: { article_id: articleId }, current_article_id: current };
    publishUser(userId, { kind: "article.sidebar_updated", data });
  }
  private publishList(userId: string, articleId: string, created = false) {
    const entry = findArticleForUser(this.db, articleId, userId);
    const data: ArticleListUpdatedPayload = entry
      ? {
          entry,
          users: userMetadataForIds(this.db, [entry.user_id]),
          ...(created ? { created: true } : {}),
        }
      : { removed: { article_id: articleId } };
    publishUser(userId, { kind: "article.list_updated", data });
  }
}

export function createArticleService(db: Database): ArticleService {
  return new ArticleService(db);
}
