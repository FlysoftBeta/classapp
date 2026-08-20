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
import type { AccessService } from "@/server/services/accessService";
import type { BooklistService } from "@/server/services/booklistService";
import type { AccessGrant, PrincipalRef } from "@/shared/access";
import { collectionSource } from "@/shared/access";

export type { CreateArticleInput, CreateBundleArticleInput };

export class ArticleActorFacade {
  constructor(
    private readonly actor: Actor,
    private readonly articles: ArticleService,
    private readonly imports: ArticleImportService,
    private readonly groups: GroupService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly booklistService: BooklistService,
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

  private requireAccess(
    userId: string,
    articleId: string,
    capability?: string,
  ) {
    const article = this.articles.access(articleId);
    const auth = this.access.authorizeOwnerless(
      userId,
      "article",
      articleId,
      capability,
    );
    this.access.recordRecent(userId, "article", articleId);
    return { article, capability: auth.capability };
  }

  private requireBooklistWrite(userId: string, booklistId: string) {
    return this.access.authorizeOwned(userId, "booklist", booklistId, "write");
  }

  private withCapabilities(
    userId: string,
    articles: ArticleWithMeta[],
  ): ArticleWithMeta[] {
    const reachable: ArticleWithMeta[] = [];
    for (const article of articles) {
      const capability =
        article.capability ??
        this.access.presentOwnerless(userId, "article", article.id);
      if (!capability) continue;
      reachable.push({ ...article, capability });
    }
    return reachable;
  }

  private pageArticles(
    articles: ArticleWithMeta[],
    users: UserMetadata[],
    input: {
      cursor?: { sortAt: string; id: string };
      direction?: "before" | "after";
    },
  ): {
    articles: ArticleWithMeta[];
    users: UserMetadata[];
    hasMore: boolean;
  } {
    let page = articles;
    if (input.cursor) {
      const index = page.findIndex((article) => article.id === input.cursor!.id);
      if (index >= 0) {
        page =
          input.direction === "before"
            ? page.slice(0, index)
            : page.slice(index + 1);
      }
    }
    const hasMore = page.length > 50;
    const sliced = page.slice(0, 50);
    const ids = new Set(sliced.map((article) => article.user_id));
    return {
      articles: sliced,
      users: users.filter((user) => ids.has(user.id)),
      hasMore,
    };
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
    if (input.groupId) {
      this.requireMember(user.id, input.groupId);
      const snapshot = this.booklistService.fetchForGroup(user.id, input.groupId);
      if (!snapshot) {
        return { articles: [], users: [], hasMore: false };
      }
      return this.pageArticles(snapshot.articles, snapshot.users, input);
    }
    const view = input.view === "bookmarked" ? "bookmarked" : "recent";
    const ids =
      view === "bookmarked"
        ? this.access.listFavorites(user.id, "article", "ownerless")
        : this.access.listRecents(user.id, "article", "ownerless");
    const loaded = this.articles.byIds(user.id, ids);
    return this.pageArticles(
      this.withCapabilities(user.id, loaded.articles),
      loaded.users,
      input,
    );
  }

  async library() {
    const user = await this.actor.requireFeature("articles");
    const recents = this.withCapabilities(
      user.id,
      this.articles.byIds(user.id, this.access.listRecents(user.id, "article", "ownerless"))
        .articles,
    );
    const favorites = this.withCapabilities(
      user.id,
      this.articles.byIds(
        user.id,
        this.access.listFavorites(user.id, "article", "ownerless"),
      ).articles,
    );
    const users = this.articles.byIds(user.id, [
      ...recents.map((article) => article.id),
      ...favorites.map((article) => article.id),
    ]).users;
    return {
      recents,
      favorites,
      booklists: this.booklistService.list(user.id),
      users,
    };
  }

  async sidebar(): Promise<ArticleSidebarPayload> {
    const user = await this.actor.requireFeature("articles");
    const payload = this.articles.sidebar(user.id);
    const articles = this.withCapabilities(user.id, payload.articles);
    const current =
      payload.current_article_id &&
      articles.some((article) => article.id === payload.current_article_id)
        ? payload.current_article_id
        : articles[0]?.id ?? null;
    return { ...payload, articles, current_article_id: current };
  }

  private resolvePublishBooklist(user: User, groupId: string): string {
    this.requireCanPublish(user, groupId);
    const group = this.groups.get(groupId);
    const title = group ? `${group.name}的文单` : "群组文单";
    return this.booklistService.ensureGroupBooklist(user.id, groupId, title).list.id;
  }

  private attachToBooklist(
    userId: string,
    booklistId: string,
    articleId: string,
  ): string {
    const snapshot = this.booklistService.addArticle(userId, booklistId, articleId);
    const capability = this.access.signOwnerless(
      "article",
      articleId,
      collectionSource("booklist", booklistId, snapshot.list.revision),
    );
    this.access.rememberPossession(userId, "article", articleId, capability);
    return capability;
  }

  async createText(
    input: CreateArticleInput,
  ): Promise<{ article: ArticleWithMeta; users: UserMetadata[]; capability: string }> {
    const user = await this.actor.requireFeature("articles");
    await this.actor.requireFeature("article_reader");
    const booklistId = this.resolvePublishBooklist(user, input.group_id);
    const result = this.articles.createText(user.id, input);
    const capability = this.attachToBooklist(user.id, booklistId, result.article.id);
    return {
      ...result,
      article: { ...result.article, group_id: input.group_id, capability },
      capability,
    };
  }

  async createBundle(
    input: CreateBundleArticleInput,
  ): Promise<{ article: ArticleWithMeta; users: UserMetadata[]; capability: string }> {
    const user = await this.actor.requireFeature("articles");
    await this.actor.requireFeature("ebook_reader");
    const booklistId = this.resolvePublishBooklist(user, input.group_id);
    const result = this.articles.createBundle(user.id, input);
    const capability = this.attachToBooklist(user.id, booklistId, result.article.id);
    return {
      ...result,
      article: { ...result.article, group_id: input.group_id, capability },
      capability,
    };
  }

  /** Authorize the multipart target before the HTTP adapter renders the file. */
  async authorizeBundleUpload(groupId: string): Promise<{ userId: string; booklistId: string }> {
    const user = await this.actor.requireFeature("articles");
    await this.actor.requireFeature("ebook_reader");
    const booklistId = this.resolvePublishBooklist(user, groupId);
    return { userId: user.id, booklistId };
  }

  /** Store and render one multipart PDF; DB publication stays a separate step. */
  async storeBundleFile(file: File, userId: string, booklistId: string) {
    await this.actor.requireFeature("articles");
    await this.actor.requireFeature("ebook_reader");
    this.requireBooklistWrite(userId, booklistId);
    return this.articles.storeBundle(file, { userId, booklistId });
  }

  async getMeta(
    articleId: string,
    capability?: string,
  ): Promise<{ article: ArticleWithMeta; users: UserMetadata[] }> {
    const user = await this.actor.requireFeature("articles");
    const access = this.requireAccess(user.id, articleId, capability);
    const result = this.articles.getMeta(user.id, articleId);
    await this.actor.requireFeature(
      result.article.content_kind === "bundle"
        ? "ebook_reader"
        : "article_reader",
    );
    return {
      ...result,
      article: { ...result.article, capability: access.capability },
    };
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
    capability?: string,
  ) {
    await this.getMeta(articleId, capability);
    return this.articles.openSource(articleId, range);
  }

  async storedBundle(articleId: string, capability?: string) {
    await this.getMeta(articleId, capability);
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
    capability?: string,
  ): Promise<{ value: boolean; updatedAt: number }> {
    const user = await this.actor.requireFeature("articles");
    this.requireAccess(user.id, articleId, capability);
    const value = this.access.favorite(
      user.id,
      "article",
      articleId,
      bookmarked,
      updatedAt,
      "ownerless",
      capability,
    );
    this.articles.notifyPreference(user.id, articleId);
    return value;
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
    const article = this.requireAccess(user.id, articleId).article;
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

  async booklists() {
    const user = await this.actor.requireFeature("articles");
    return { booklists: this.booklistService.list(user.id) };
  }

  async fetchBooklist(booklistId: string) {
    const user = await this.actor.requireFeature("articles");
    return this.booklistService.fetch(user.id, booklistId);
  }

  async booklistForGroup(groupId: string) {
    const user = await this.actor.requireFeature("articles");
    this.requireMember(user.id, groupId);
    return this.booklistService.fetchForGroup(user.id, groupId);
  }

  async createBooklist(title: string) {
    const user = await this.actor.requireFeature("articles");
    return this.booklistService.create(user.id, title.trim() || "新文单");
  }

  async deleteBooklist(booklistId: string) {
    const user = await this.actor.requireFeature("articles");
    this.booklistService.delete(user.id, booklistId);
  }

  async addToBooklist(
    booklistId: string,
    articleId: string,
    capability?: string,
  ) {
    const user = await this.actor.requireFeature("articles");
    this.access.authorizeOwnerless(user.id, "article", articleId, capability);
    return this.booklistService.addArticle(user.id, booklistId, articleId);
  }

  async removeFromBooklist(booklistId: string, articleId: string) {
    const user = await this.actor.requireFeature("articles");
    return this.booklistService.removeArticle(user.id, booklistId, articleId);
  }

  async grantBooklistAccess(
    booklistId: string,
    principal: PrincipalRef,
    grant: AccessGrant,
  ) {
    const user = await this.actor.requireFeature("articles");
    return this.booklistService.grant(user.id, booklistId, principal, grant);
  }

  async revokeBooklistAccess(booklistId: string, principal: PrincipalRef) {
    const user = await this.actor.requireFeature("articles");
    return this.booklistService.revoke(user.id, booklistId, principal);
  }

  async booklistBindings(booklistId: string) {
    const user = await this.actor.requireFeature("articles");
    this.access.authorizeOwned(user.id, "booklist", booklistId, "read");
    return { bindings: this.booklistService.bindings(booklistId) };
  }
}
