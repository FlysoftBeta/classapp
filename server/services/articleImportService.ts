import type { User } from "@/shared/types/api";
import type { ArticleImportSticky } from "@/server/runtime/sticky";

/** Request-scoped view of sticky article-import occupancy. Not a second owner. */
export class ArticleImportService {
  constructor(private readonly imports: ArticleImportSticky) {}

  search(userId: string, query: string) {
    return this.imports.search(userId, query);
  }

  start(user: User, bookId: string, groupId: string, titleHint = "") {
    return this.imports.start(user, bookId, groupId, titleHint);
  }

  list(userId: string) {
    return this.imports.list(userId);
  }
}

export function createArticleImportService(
  imports: ArticleImportSticky,
): ArticleImportService {
  return new ArticleImportService(imports);
}
