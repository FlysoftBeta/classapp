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
  listArticlesByIds,
  listArticlesForUser,
  listBookmarkedArticleRows,
  rowToArticle,
  touchArticleProgress,
  upsertArticleProgressOffset,
  purgeArticlesForUser,
} from "@/server/data/articles";
import {
  listFavoriteIds,
  listRecentIds,
  touchRecent,
  upsertFavorite,
} from "@/server/data/preferences";
import { groupIdsForArticle } from "@/server/data/booklists";
import { userMetadataForIds } from "@/server/data/users";
import {
  PublicError,
  ContractViolationError,
  recordContainedServerIncident,
} from "@/server/services/incidentService";
import { publishGroupArticle, publishUser } from "@/server/runtime/eventBus";
import {
  deleteUserConfig,
  getUserConfig,
  setUserConfig,
} from "@/server/services/userConfig";
import { renderPdfArchive } from "@/server/infra/pdfRenderProcess";
import { BUILD_ID } from "@/server/infra/env";
import {
  forgetRenderArchive,
  inspectRenderArchiveFile,
  loadRenderArchive,
  type StoredRenderArchive,
} from "@/server/storage/renderArchive";
import { BlobStore, type BlobRead } from "@/server/storage/blobStore";
import {
  abandonArticleUpload,
  claimArticleUpload,
  insertArticleUpload,
  updateArticleUploadBytes,
} from "@/server/data/articleUploads";
import { QuotaService } from "@/server/storage/quotaService";
import { bytes, formatBytes } from "@/shared/bytes";
import { READING_HISTORY_MIN_SECONDS } from "@/shared/types/api/article";
import type { BundleSlice } from "@/shared/bundles/protocol";

export const ARTICLE_SOURCE_POOL = "article-source";
export const ARTICLE_ARCHIVE_POOL = "article-archive";
const ARTICLE_HALF_LIFE_MS = 7 * 24 * 60 * 60_000;
export const MAX_ARTICLE_SOURCE_BYTES = bytes("200 MB");

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
  upload_id?: string;
}

export type StoredArticleBundle = Omit<
  CreateBundleArticleInput,
  "title" | "group_id"
>;

function requireTrimmed(value: string, message: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new ContractViolationError(message);
  return trimmed;
}

function normalizeArticleMime(file: File): StoredArticleBundle["source_mime"] {
  const name = file.name.toLowerCase();
  if (file.type === "application/pdf" || name.endsWith(".pdf")) {
    return "application/pdf";
  }
  throw new PublicError("仅支持 PDF 文件");
}

export class ArticleService {
  private readonly quota = new QuotaService(this.db);

  constructor(
    private readonly db: Database,
    private readonly blobs: BlobStore,
  ) {}

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

  byIds(
    userId: string,
    ids: string[],
  ): { articles: ArticleWithMeta[]; users: UserMetadata[] } {
    const articles = listArticlesByIds(this.db, userId, ids);
    return {
      articles,
      users: userMetadataForIds(
        this.db,
        articles.map((article) => article.user_id),
      ),
    };
  }

  notifyPreference(userId: string, articleId: string): void {
    this.publishSidebar(userId, articleId);
    this.publishList(userId, articleId);
  }

  recordRecent(userId: string, articleId: string): void {
    touchRecent(this.db, userId, "article", articleId);
  }

  listRecents(userId: string): string[] {
    return listRecentIds(this.db, userId, "article");
  }

  listFavorites(userId: string): string[] {
    return listFavoriteIds(this.db, userId, "article");
  }

  setFavorite(
    userId: string,
    articleId: string,
    favorited: boolean,
    updatedAt: number,
  ): { value: boolean; updatedAt: number } {
    return upsertFavorite(
      this.db,
      userId,
      "article",
      articleId,
      favorited,
      updatedAt,
    );
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
    );
    this.notifyCreated(userId, article.id);
    return {
      article,
      users: userMetadataForIds(this.db, [article.user_id]),
    };
  }

  /**
   * Persist source, render, validate, publish both objects. A durable upload
   * row is created first, so a crash or disconnected client can be compensated
   * by ArticleUploadRuntime instead of leaking objects. The HTTP adapter only
   * inserts the DB row after this returns.
   */
  async storeBundle(
    file: File,
    owner: { userId: string; booklistId: string },
  ): Promise<StoredArticleBundle & { upload_id: string }> {
    if (!file.size) throw new PublicError("文件不能为空");
    if (file.size > MAX_ARTICLE_SOURCE_BYTES) {
      throw new PublicError(
        `文件不能超过 ${formatBytes(MAX_ARTICLE_SOURCE_BYTES)}`,
      );
    }
    const sourceMime = normalizeArticleMime(file);
    this.ensureQuotaPools();
    const uploadId = crypto.randomUUID();
    const sourceSlot = await this.blobs.create();
    const archiveSlot = await this.blobs.create();
    insertArticleUpload(this.db, {
      id: uploadId,
      userId: owner.userId,
      booklistId: owner.booklistId,
      sourceBlobId: sourceSlot.id,
      archiveBlobId: archiveSlot.id,
    });
    let archiveCommitted = false;
    try {
      await this.blobs.writeSlot(sourceSlot, file.stream(), file.size);
      await sourceSlot.commit({ expectedBytes: file.size });
      await renderPdfArchive(
        this.blobs.materializedPath(sourceSlot.id),
        archiveSlot.path,
      );
      const index = await inspectRenderArchiveFile(archiveSlot.path);
      await archiveSlot.commit({ expectedBytes: index.archiveSize });
      archiveCommitted = true;
      const stored: StoredArticleBundle = {
        source_path: sourceSlot.id,
        archive_path: archiveSlot.id,
        source_mime: sourceMime,
        source_size: file.size,
        archive_size: index.archiveSize,
        original_filename: file.name || "document.pdf",
        item_count: index.header.item_count,
      };
      updateArticleUploadBytes(this.db, uploadId, {
        sourceBytes: stored.source_size,
        archiveBytes: stored.archive_size,
      });
      this.quota.account(ARTICLE_SOURCE_POOL, sourceSlot.id, {
        weight: stored.source_size,
        class: "durable",
      });
      this.quota.account(ARTICLE_ARCHIVE_POOL, archiveSlot.id, {
        weight: stored.archive_size,
        class: "cache",
      });
      return { ...stored, upload_id: uploadId };
    } catch (error) {
      await archiveSlot.discard();
      await sourceSlot.discard();
      if (archiveCommitted) {
        await this.blobs.drop(archiveSlot.id).catch(() => undefined);
      }
      await this.blobs.drop(sourceSlot.id).catch(() => undefined);
      this.quota.release(ARTICLE_SOURCE_POOL, sourceSlot.id);
      this.quota.release(ARTICLE_ARCHIVE_POOL, archiveSlot.id);
      abandonArticleUpload(this.db, uploadId);
      throw error;
    }
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
    this.db.transaction(() => {
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
      });
      if (input.upload_id) {
        const claimed = claimArticleUpload(
          this.db,
          input.upload_id,
          input.source_path,
          input.archive_path,
        );
        if (!claimed)
          throw new ContractViolationError("上传会话不存在或已失效");
      }
    })();
    this.ensureQuotaPools();
    this.quota.release(ARTICLE_SOURCE_POOL, input.source_path);
    this.quota.release(ARTICLE_ARCHIVE_POOL, input.archive_path);
    this.quota.account(ARTICLE_SOURCE_POOL, id, {
      weight: input.source_size,
      class: "durable",
    });
    this.quota.account(ARTICLE_ARCHIVE_POOL, id, {
      weight: input.archive_size,
      class: "cache",
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

  async openSource(
    articleId: string,
    range?: { start?: number; end?: number; suffixLength?: number },
  ): Promise<BlobRead> {
    const article = this.requireBundleRecord(articleId);
    this.quota.touch(ARTICLE_SOURCE_POOL, articleId, 1);
    return this.blobs.open(article.source_path, range);
  }

  async storedBundle(articleId: string): Promise<StoredRenderArchive> {
    const article = this.requireBundleRecord(articleId);
    this.quota.touch(ARTICLE_ARCHIVE_POOL, articleId, 1);
    return loadRenderArchive(this.blobs, article.archive_path);
  }

  async openBundle(input: {
    articleId: string;
    cursor: number | null;
    before: number;
    after: number;
  }): Promise<BundleSlice> {
    const index = await this.storedBundle(input.articleId);
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
    const index = await this.storedBundle(input.articleId);
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
    const groupIds = groupIdsForArticle(this.db, articleId);
    deleteArticleById(this.db, articleId);
    if (record?.content_kind === "bundle")
      await this.removeBundle(record.source_path, record.archive_path, articleId);
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
    for (const groupId of groupIds) {
      publishGroupArticle(groupId, {
        kind: "article.list_updated",
        data: { refresh: true },
      });
    }
  }

  async purgeUser(userId: string): Promise<void> {
    for (const artifact of purgeArticlesForUser(this.db, userId)) {
      await this.removeBundle(
        artifact.sourcePath,
        artifact.archivePath,
        artifact.articleId,
      );
    }
  }

  private insertText(
    userId: string,
    title: string,
    content: string,
  ) {
    const id = crypto.randomUUID();
    insertTextArticle(this.db, { id, userId, title, content });
    return this.requireOwned(id, userId);
  }

  private requireBundleRecord(articleId: string) {
    const article = findArticleRecord(this.db, articleId);
    if (
      !article ||
      article.content_kind !== "bundle" ||
      !article.source_path ||
      !article.archive_path
    ) {
      throw new PublicError("文档资源不存在");
    }
    return {
      source_path: article.source_path,
      archive_path: article.archive_path,
    };
  }

  async discardBundle(stored: StoredArticleBundle): Promise<void> {
    await this.removeBundle(stored.source_path, stored.archive_path);
    if (stored.upload_id) abandonArticleUpload(this.db, stored.upload_id);
  }

  async removeBundle(
    sourcePath: string | null | undefined,
    archivePath: string | null | undefined,
    quotaItemId?: string | null,
  ): Promise<void> {
    if (archivePath) forgetRenderArchive(archivePath);
    for (const blobId of [sourcePath, archivePath]) {
      if (!blobId) continue;
      try {
        await this.blobs.drop(blobId);
      } catch (error) {
        recordContainedServerIncident(this.db, BUILD_ID, error, {
          component: "article-bundles",
          phase: "drop",
          blob_id: blobId,
        });
      }
    }
    const sourceItem = quotaItemId ?? sourcePath;
    const archiveItem = quotaItemId ?? archivePath;
    if (sourceItem) this.quota.release(ARTICLE_SOURCE_POOL, sourceItem);
    if (archiveItem) this.quota.release(ARTICLE_ARCHIVE_POOL, archiveItem);
  }

  private ensureQuotaPools(): void {
    const shared = {
      maxWeight: 0,
      targetRatio: 0.8,
      halfLifeMs: ARTICLE_HALF_LIFE_MS,
    };
    this.quota.configure({ name: ARTICLE_SOURCE_POOL, ...shared });
    this.quota.configure({ name: ARTICLE_ARCHIVE_POOL, ...shared });
  }

  private sliceBundle(
    index: StoredRenderArchive,
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
    for (const groupId of groupIdsForArticle(this.db, articleId)) {
      publishGroupArticle(groupId, {
        kind: "article.list_updated",
        data: { refresh: true },
      });
    }
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

export function createArticleService(
  db: Database,
  blobs: BlobStore,
): ArticleService {
  return new ArticleService(db, blobs);
}
