import type { Actor } from "@/server/runtime/actor";
import type { CreatePostInput } from "@/server/validation/posts";
import type {
  PostListInput,
  PostService,
} from "@/server/services/postsService";
import type { GroupService } from "@/server/services/groupsService";
import { PublicError } from "@/server/services/incidentService";
import { parseConvId } from "@/shared/conversations/id";
import type { PostEntity, User } from "@/shared/types/api";
import {
  isStoredEditable,
  parseStoredPostContent,
} from "@/server/services/postContent";
import type { AuditService } from "@/server/services/auditService";
import type { PostImageService } from "@/server/services/postImagesService";
import type { StickyHost } from "@/server/runtime/sticky";
import { isImagePost } from "@/shared/types/api";

export class PostActorFacade {
  constructor(
    private readonly actor: Actor,
    private readonly posts: PostService,
    private readonly groups: GroupService,
    private readonly audit: AuditService,
    private readonly images: PostImageService,
    private readonly sticky: StickyHost,
  ) {}

  private requireGroupAccess(user: User, groupId: string): void {
    if (
      !this.actor.hasRole("administrator") &&
      !this.groups.isMember(user.id, groupId)
    ) {
      throw new PublicError("你不在该群组中");
    }
  }

  private requireCanPublishToGroup(user: User, groupId: string): void {
    if (user.is_muted) throw new PublicError("你已被禁言");
    this.requireGroupAccess(user, groupId);
    if (
      this.groups.isGroupAdminOnly(groupId) &&
      !this.actor.hasRole("administrator")
    ) {
      throw new PublicError("该群组仅管理员可以发言");
    }
  }

  private requireConversationAccess(user: User, convId: string) {
    const parsed = parseConvId(convId);
    if (!parsed) throw new PublicError("会话 ID 无效");
    if (parsed.type === "group") {
      this.requireGroupAccess(user, parsed.groupId);
    } else {
      if (parsed.peerA !== user.id && parsed.peerB !== user.id) {
        throw new PublicError("无权访问");
      }
      if (!this.posts.directConversationExists(parsed.peerA, parsed.peerB)) {
        throw new PublicError("对话不存在");
      }
    }
    return parsed;
  }

  private requirePostAccess(user: User, postId: string) {
    const post = this.posts.access(postId);
    this.requireConversationAccess(user, post.conv_id);
    return post;
  }

  private prepareImageThumbs(posts: readonly PostEntity[]): void {
    for (const post of posts) {
      if (!isImagePost(post)) continue;
      this.sticky.postImages.prepare(post.image_id);
    }
  }

  async list(input: PostListInput) {
    const user = await this.actor.requireUser();
    if (input.type === "conversation") {
      if (!input.conv_id) throw new PublicError("缺少会话 ID");
      this.requireConversationAccess(user, input.conv_id);
    }
    const result = this.posts.list(user.id, input);
    this.prepareImageThumbs(result.posts);
    return result;
  }

  async get(postId: string) {
    const user = await this.actor.requireUser();
    this.requirePostAccess(user, postId);
    const result = this.posts.get(postId);
    this.prepareImageThumbs([result.post]);
    return result;
  }

  private async authorizeCreate(raw: {
    conv_id: string;
    reply_to?: string | null;
  }) {
    const user = await this.actor.requireUser();
    if (user.is_muted) throw new PublicError("你已被禁言");
    const conversation = parseConvId(raw.conv_id);
    if (!conversation) throw new PublicError("会话 ID 无效");
    let authorizedDirectPeerId: string | undefined;
    if (conversation.type === "group") {
      this.requireCanPublishToGroup(user, conversation.groupId);
    } else {
      if (conversation.peerA !== user.id && conversation.peerB !== user.id) {
        throw new PublicError("无权建立该私信");
      }
      const peerId =
        conversation.peerA === user.id
          ? conversation.peerB
          : conversation.peerA;
      authorizedDirectPeerId = peerId;
    }
    if (raw.reply_to) {
      const reply = this.requirePostAccess(user, raw.reply_to);
      if (reply.deleted_at) throw new PublicError("被引用的帖子已删除");
      if (reply.conv_id !== raw.conv_id) {
        throw new PublicError("引用帖与目标会话不匹配");
      }
    }
    return { user, authorizedDirectPeerId };
  }

  async create(raw: CreatePostInput, opts?: { deferNotify?: boolean }) {
    const input = this.posts.normalizeCreate(raw);
    const { user, authorizedDirectPeerId } = await this.authorizeCreate(input);
    return this.posts.create(user.id, input, {
      ...opts,
      authorizedDirectPeerId,
    });
  }

  async createImage(input: {
    file: File;
    conv_id: string;
    reply_to?: string | null;
  }) {
    const { user, authorizedDirectPeerId } = await this.authorizeCreate(input);
    this.actor.requireFeature("post_images");
    const ingested = await this.images.ingest(input.file);
    try {
      const result = this.posts.createImage(
        user.id,
        {
          conv_id: input.conv_id,
          reply_to: input.reply_to?.trim() || null,
          imageId: ingested.id,
        },
        { authorizedDirectPeerId },
      );
      this.sticky.postImages.prepare(ingested.id);
      return result;
    } catch (error) {
      await this.images.abandon(ingested.id);
      throw error;
    }
  }

  async update(postId: string, text: string) {
    const user = await this.actor.requireUser();
    const target = this.requirePostAccess(user, postId);
    if (!isStoredEditable(parseStoredPostContent(target.content_json))) {
      throw new PublicError("此类型消息不能编辑");
    }
    if (target.deleted_at) throw new PublicError("帖子已删除");
    if (target.user_id !== user.id) throw new PublicError("无权修改此帖");
    if (user.is_muted) throw new PublicError("你已被禁言");
    const conversation = parseConvId(target.conv_id);
    if (conversation?.type === "group") {
      this.requireCanPublishToGroup(user, conversation.groupId);
    }
    return this.posts.update(postId, text);
  }

  private async reclaimImageFromPost(contentJson: string): Promise<void> {
    const stored = parseStoredPostContent(contentJson);
    if (stored?.type !== "image") return;
    const image = this.images.lookup(stored.image_id);
    if (image) await this.images.reclaim(image);
  }

  async softDelete(postId: string) {
    const user = await this.actor.requireUser();
    const target = this.requirePostAccess(user, postId);
    if (target.user_id !== user.id) {
      const admin = this.actor.requireRole("community_manager");
      const result = this.posts.forceDelete(postId);
      this.audit.record({
        actorId: admin.id,
        action: "post.force_delete",
        targetKind: "post",
        targetId: postId,
      });
      await this.reclaimImageFromPost(target.content_json);
      return result;
    }
    const result = this.posts.softDelete(postId);
    await this.reclaimImageFromPost(target.content_json);
    return result;
  }

  async streamOriginal(imageId: string) {
    const user = await this.actor.requireUser();
    const image = this.images.get(imageId);
    if (!image.postId) throw new PublicError("图片不存在");
    this.requirePostAccess(user, image.postId);
    return this.images.openOriginal(imageId);
  }

  async streamThumb(imageId: string) {
    const user = await this.actor.requireUser();
    const image = this.images.get(imageId);
    if (!image.postId) throw new PublicError("图片不存在");
    this.requirePostAccess(user, image.postId);
    this.sticky.postImages.prepare(imageId);
    return this.images.openThumb(imageId);
  }
}
