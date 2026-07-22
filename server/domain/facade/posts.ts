import type { Actor } from "@/server/session/session";
import type { CreatePostInput } from "@/server/validation/posts";
import type { Post } from "@/shared/types/api";
import type {
  PostListInput,
  PostService,
} from "@/server/services/postsService";

export class PostActorFacade {
  constructor(
    private readonly actor: Actor,
    private readonly posts: PostService,
  ) {}

  async list(input: PostListInput): Promise<Post[]> {
    const user = await this.actor.requireUser();
    return this.posts.list(user, input);
  }

  async get(postId: string): Promise<Post> {
    const user = await this.actor.requireUser();
    return this.posts.get(user, postId);
  }

  async create(
    raw: CreatePostInput,
    opts?: { deferNotify?: boolean },
  ): Promise<Post> {
    const user = await this.actor.requireUser();
    return this.posts.create(user, raw, opts);
  }

  async update(postId: string, text: string): Promise<Post> {
    const user = await this.actor.requireUser();
    return this.posts.update(user, postId, text);
  }

  async softDelete(postId: string): Promise<void> {
    const user = await this.actor.requireUser();
    this.posts.softDelete(user, postId);
  }

  async adminList(input: { q?: string; userId?: string; offset?: number }) {
    await this.actor.requireAdmin();
    return this.posts.adminList(input);
  }

  async adminDelete(postId: string): Promise<void> {
    await this.actor.requireAdmin();
    this.posts.adminDelete(postId);
  }
}
