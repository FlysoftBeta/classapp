import type { Actor } from "@/server/session/session";
import type {
  Article,
  ArticleSidebarPayload,
  ArticleWithMeta,
} from "@/shared/types/api";
import type {
  ArticleService,
  CreateArticleInput,
  CreateBlobArticleInput,
} from "@/server/services/articlesService";
import type { ArticleImportService } from "@/server/services/articleImportService";

export type { CreateArticleInput, CreateBlobArticleInput };

export class ArticleActorFacade {
  constructor(
    private readonly actor: Actor,
    private readonly articles: ArticleService,
    private readonly imports: ArticleImportService,
  ) {}

  async list(input: {
    bookmarkedOnly?: boolean;
    offset?: number;
    groupId?: string;
  }): Promise<{ articles: (Article & ArticleWithMeta)[]; total: number }> {
    const user = await this.actor.requireFeature("articles");
    return this.articles.list(user, input);
  }

  async sidebar(): Promise<ArticleSidebarPayload> {
    const user = await this.actor.requireFeature("articles");
    return this.articles.sidebar(user);
  }

  async createText(
    input: CreateArticleInput,
  ): Promise<{ article: Article & ArticleWithMeta }> {
    const user = await this.actor.requireFeature("articles");
    await this.actor.requireFeature("article_reader");
    return this.articles.createText(user, input);
  }

  async createBlob(
    input: CreateBlobArticleInput,
  ): Promise<{ article: Article & ArticleWithMeta }> {
    const user = await this.actor.requireFeature("articles");
    await this.actor.requireFeature("ebook_reader");
    return this.articles.createBlob(user, input);
  }

  async getMeta(
    articleId: string,
  ): Promise<{ article: Omit<ArticleWithMeta, "content"> }> {
    const user = await this.actor.requireFeature("articles");
    const result = this.articles.getMeta(user, articleId);
    await this.actor.requireFeature(
      result.article.content_kind === "blob"
        ? "ebook_reader"
        : "article_reader",
    );
    return result;
  }

  async segment(input: { articleId: string; offset: number }): Promise<{
    content: string;
    offset: number;
    has_more: boolean;
    content_length: number;
  }> {
    const user = await this.actor.requireFeature("articles");
    await this.actor.requireFeature("article_reader");
    return this.articles.segment(user, input);
  }

  async setBookmark(
    articleId: string,
    bookmarked: boolean,
    updatedAt: number,
  ): Promise<{ value: boolean; updatedAt: number }> {
    const user = await this.actor.requireFeature("articles");
    return this.articles.setBookmark(user, articleId, bookmarked, updatedAt);
  }

  async saveProgress(
    articleId: string,
    offset: number,
    updatedAt: number,
  ): Promise<{ offset: number; updatedAt: number }> {
    const user = await this.actor.requireFeature("articles");
    return this.articles.saveProgress(user, articleId, offset, updatedAt);
  }

  async recordReading(
    articleId: string,
    input: { seconds?: number; active?: boolean },
  ): Promise<void> {
    const user = await this.actor.requireFeature("articles");
    this.articles.recordReading(user, articleId, input);
  }

  async delete(articleId: string): Promise<void> {
    const user = await this.actor.requireFeature("articles");
    await this.articles.delete(user, articleId);
  }

  async searchNetwork(query: string) {
    const user = await this.actor.requireFeature("article_download");
    await this.actor.requireFeature("articles");
    return this.imports.search(user.id, query);
  }

  async startNetworkDownload(bookId: string, groupId: string, title?: string) {
    const user = await this.actor.requireFeature("article_download");
    await this.actor.requireFeature("article_reader");
    return { task: this.imports.start(user, bookId, groupId, title) };
  }

  async listNetworkDownloads() {
    const user = await this.actor.requireFeature("article_download");
    return { tasks: this.imports.list(user.id) };
  }
}
