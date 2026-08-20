import type { Database } from "better-sqlite3";
import { PublicError } from "@/server/services/incidentService";
import { AuthorizationError } from "@/server/services/authorizationError";
import type { AccessService } from "@/server/services/accessService";
import {
  addBooklistItem,
  booklistContents,
  createBooklistRow,
  deleteBooklist,
  findGroupBooklistId,
  listBooklistsByIds,
  removeBooklistItem,
} from "@/server/data/booklists";
import { listArticlesByIds } from "@/server/data/articles";
import { userMetadataForIds } from "@/server/data/users";
import type { AccessGrant, PrincipalRef } from "@/shared/access";
import type { BooklistSnapshot, BooklistSummary } from "@/shared/types/api";

export class BooklistService {
  constructor(
    private readonly db: Database,
    private readonly access: AccessService,
  ) {}

  private signed(userId: string, listId: string): BooklistSnapshot {
    const auth = this.access.authorizeOwned(userId, "booklist", listId, "read");
    const contents = booklistContents(this.db, listId);
    this.access.recordRecent(userId, "booklist", listId);
    const articleIds = contents.items.map((item) => item.article_id);
    const articles = listArticlesByIds(this.db, userId, articleIds).map(
      (article) => {
        const capability = this.access.signOwnerless("article", article.id, {
          type: "booklist",
          list_id: listId,
          revision: contents.list.revision,
        });
        this.access.rememberPossession(userId, "article", article.id, capability);
        return { ...article, capability };
      },
    );
    return {
      list: { ...contents.list, access: auth.flags },
      items: contents.items,
      articles,
      users: userMetadataForIds(
        this.db,
        articles.map((article) => article.user_id),
      ),
    };
  }

  list(userId: string): BooklistSummary[] {
    const ids = this.access.listAccessibleIds(userId, "booklist");
    return listBooklistsByIds(this.db, ids).map((list) => ({
      ...list,
      access: this.access.peekOwned(userId, "booklist", list.id),
    }));
  }

  fetch(userId: string, listId: string): BooklistSnapshot {
    try {
      return this.signed(userId, listId);
    } catch (error) {
      if (error instanceof AuthorizationError) throw error;
      throw new PublicError("文单不存在");
    }
  }

  fetchForGroup(userId: string, groupId: string): BooklistSnapshot | null {
    const existing = findGroupBooklistId(this.db, groupId);
    if (!existing) return null;
    return this.fetch(userId, existing);
  }

  create(
    userId: string,
    title: string,
    originGroupId: string | null = null,
  ): BooklistSnapshot {
    const snapshot = this.db.transaction(() => {
      const id = createBooklistRow(this.db, title, originGroupId);
      if (originGroupId) {
        this.access.bindOwner("booklist", id, {
          kind: "group",
          id: originGroupId,
        });
      } else {
        this.access.bindOwner("booklist", id, { kind: "user", id: userId });
      }
      return this.signed(userId, id);
    })();
    return snapshot;
  }

  ensureGroupBooklist(
    userId: string,
    groupId: string,
    title: string,
  ): BooklistSnapshot {
    const existing = findGroupBooklistId(this.db, groupId);
    if (existing) return this.fetch(userId, existing);
    return this.create(userId, title, groupId);
  }

  addArticle(
    userId: string,
    listId: string,
    articleId: string,
  ): BooklistSnapshot {
    this.access.authorizeOwned(userId, "booklist", listId, "write");
    addBooklistItem(this.db, listId, articleId);
    return this.signed(userId, listId);
  }

  removeArticle(
    userId: string,
    listId: string,
    articleId: string,
  ): BooklistSnapshot {
    this.access.authorizeOwned(userId, "booklist", listId, "write");
    removeBooklistItem(this.db, listId, articleId);
    return this.signed(userId, listId);
  }

  delete(userId: string, listId: string): void {
    this.access.authorizeOwned(userId, "booklist", listId, "own");
    this.access.dropResource("booklist", listId);
    deleteBooklist(this.db, listId);
  }

  grant(
    userId: string,
    listId: string,
    principal: PrincipalRef,
    grant: AccessGrant,
  ): BooklistSnapshot {
    this.access.grant(userId, "booklist", listId, principal, grant);
    return this.signed(userId, listId);
  }

  revoke(
    userId: string,
    listId: string,
    principal: PrincipalRef,
  ): BooklistSnapshot {
    this.access.revoke(userId, "booklist", listId, principal);
    return this.signed(userId, listId);
  }

  bindings(listId: string) {
    return this.access.listBindings("booklist", listId).map((row) => ({
      principal: row.principal,
      grants: row.grants,
      flags: row.flags,
    }));
  }
}
