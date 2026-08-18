import type { Actor } from "@/server/runtime/actor";
import type {
  ArticleSidebarPayload,
  ArticleWithMeta,
  UserMetadata,
} from "@/shared/types/api";
import type {
  ArticleService,
  CreateArticleInput,
  CreateBundleArticleInput,
} from "@/server/services/articlesService";
import type { ArticleImportService } from "@/server/services/articleImportService";
import type { GroupService } from "@/server/services/groupsService";
import { PublicError } from "@/server/services/incidentService";
import type { User } from "@/shared/types/api";
import type { AuditService } from "@/server/services/auditService";

export type { CreateArticleInput, CreateBundleArticleInput };

export class ArticleActorFacade {
  constructor(
    private readonly actor: Actor,
    private readonly articles: ArticleService,
    private readonly imports: ArticleImportService,
    private readonly groups: GroupService,
    private readonly audit: AuditService,
  ) {}

  private requireMember(userId: string, groupId: string): void {
    if (!this.groups.isMember(userId, groupId)) {
      throw new PublicError("你不在该群组中");
    }
  }

  private requireCanPublish(user: User, groupId: string): void {
    if (user.is_muted) throw new PublicError("你已被禁言");
    this.requireMember(user.id, groupId);
    if (
      this.groups.isGroupAdminOnly(groupId) &&
      !this.actor.hasRole("administrator")
    ) {
      throw new PublicError("该群组仅管理员可以发言");
    }
  }

  private requireAccess(userId: string, articleId: string) {
    const article = this.articles.access(articleId);
    this.requireMember(userId, article.group_id);
    return article;
  }

  async list(input: {
    view?: "all" | "bookmarked" | "recent";
    cursor?: { sortAt: string; id: string };
    direction?: "before" | "after";
    groupId?: string;
  }): Promise<{
    articles: ArticleWithMeta[];
    users: UserMetadata[];
    hasMore: boolean;
  }> {
    const user = await this.actor.requireFeature("articles");
    if (input.groupId) this.requireMember(user.id, input.groupId);
    return this.articles.list(user.id, input);
  }

  async sidebar(): Promise<ArticleSidebarPayload> {
    const user = await this.actor.requireFeature("articles");
    return this.articles.sidebar(user.id);
  }

  async createText(
    input: CreateArticleInput,
  ): Promise<{ article: ArticleWithMeta; users: UserMetadata[] }> {
    const user = await this.actor.requireFeature("articles");
    await this.actor.requireFeature("article_reader");
    this.requireCanPublish(user, input.group_id);
    return this.articles.createText(user.id, input);
  }

  async createBundle(
    input: CreateBundleArticleInput,
  ): Promise<{ article: ArticleWithMeta; users: UserMetadata[] }> {
    const user = await this.actor.requireFeature("articles");
    await this.actor.requireFeature("ebook_reader");
    this.requireCanPublish(user, input.group_id);
    return this.articles.createBundle(user.id, input);
  }

  /** Authorize the multipart target before the HTTP adapter renders the file. */
  async authorizeBundleUpload(groupId: string): Promise<string> {
    const user = await this.actor.requireFeature("articles");
    await this.actor.requireFeature("ebook_reader");
    this.requireCanPublish(user, groupId);
    return user.id;
  }

  /** Store and render one multipart PDF; DB publication stays a separate step. */
  async storeBundleFile(file: File, userId: string, groupId: string) {
    await this.actor.requireFeature("articles");
    await this.actor.requireFeature("ebook_reader");
    this.requireCanPublish(await this.actor.requireUser(), groupId);
    return this.articles.storeBundle(file, { userId, groupId });
  }

  async getMeta(
    articleId: string,
  ): Promise<{ article: ArticleWithMeta; users: UserMetadata[] }> {
    const user = await this.actor.requireFeature("articles");
    this.requireAccess(user.id, articleId);
    const result = this.articles.getMeta(user.id, articleId);
    await this.actor.requireFeature(
      result.article.content_kind === "bundle"
        ? "ebook_reader"
        : "article_reader",
    );
    return result;
  }

  async discardBundleFile(
    stored: Awaited<ReturnType<ArticleService["storeBundle"]>>,
  ) {
    await this.actor.requireFeature("articles");
    return this.articles.discardBundle(stored);
  }

  async streamBundleSource(
    articleId: string,
    range?: { start?: number; end?: number; suffixLength?: number },
  ) {
    await this.getMeta(articleId);
    return this.articles.openSource(articleId, range);
  }

  async storedBundle(articleId: string) {
    await this.getMeta(articleId);
    return this.articles.storedBundle(articleId);
  }

  async segment(input: { articleId: string; offset: number }): Promise<{
    content: string;
    offset: number;
    has_more: boolean;
    content_length: number;
  }> {
    const user = await this.actor.requireFeature("articles");
    await this.actor.requireFeature("article_reader");
    this.requireAccess(user.id, input.articleId);
    return this.articles.segment(input);
  }

  async openBundle(input: {
    articleId: string;
    cursor: number | null;
    before: number;
    after: number;
  }) {
    const user = await this.actor.requireFeature("articles");
    await this.actor.requireFeature("ebook_reader");
    this.requireAccess(user.id, input.articleId);
    return this.articles.openBundle(input);
  }

  async fetchBundle(input: {
    articleId: string;
    cursor: number;
    direction: "before" | "after";
    limit: number;
  }) {
    const user = await this.actor.requireFeature("articles");
    await this.actor.requireFeature("ebook_reader");
    this.requireAccess(user.id, input.articleId);
    return this.articles.fetchBundle(input);
  }

  async setBookmark(
    articleId: string,
    bookmarked: boolean,
    updatedAt: number,
  ): Promise<{ value: boolean; updatedAt: number }> {
    const user = await this.actor.requireFeature("articles");
    this.requireAccess(user.id, articleId);
    return this.articles.setBookmark(user.id, articleId, bookmarked, updatedAt);
  }

  async saveProgress(
    articleId: string,
    offset: number,
    updatedAt: number,
    merge: "override" | "furthest",
  ): Promise<{ offset: number; updatedAt: number }> {
    const user = await this.actor.requireFeature("articles");
    this.requireAccess(user.id, articleId);
    return this.articles.saveProgress(
      user.id,
      articleId,
      offset,
      updatedAt,
      merge,
    );
  }

  async recordReading(
    articleId: string,
    input: { seconds?: number; active?: boolean },
  ): Promise<void> {
    const user = await this.actor.requireFeature("articles");
    this.requireAccess(user.id, articleId);
    this.articles.recordReading(user.id, articleId, input);
  }

  async delete(articleId: string): Promise<void> {
    const user = await this.actor.requireFeature("articles");
    const article = this.requireAccess(user.id, articleId);
    if (article.user_id !== user.id) {
      const admin = this.actor.requireRole("community_manager");
      await this.articles.delete(user.id, articleId);
      this.audit.record({
        actorId: admin.id,
        action: "article.force_delete",
        targetKind: "article",
        targetId: articleId,
      });
      return;
    }
    await this.articles.delete(user.id, articleId);
  }

  async searchNetwork(query: string) {
    const user = await this.actor.requireFeature("article_download");
    await this.actor.requireFeature("articles");
    return this.imports.search(user.id, query);
  }

  async startNetworkDownload(bookId: string, groupId: string, title?: string) {
    const user = await this.actor.requireFeature("article_download");
    await this.actor.requireFeature("article_reader");
    this.requireCanPublish(user, groupId);
    return { task: await this.imports.start(user, bookId, groupId, title) };
  }

  async listNetworkDownloads() {
    const user = await this.actor.requireFeature("article_download");
    return { tasks: await this.imports.list(user.id) };
  }
}
