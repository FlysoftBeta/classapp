import type { Actor } from "@/server/runtime/actor";
import type { CreatePostInput } from "@/server/validation/posts";
import type {
  PostListInput,
  PostService,
} from "@/server/services/postsService";
import type { GroupService } from "@/server/services/groupsService";
import { PublicError } from "@/server/services/incidentService";
import { parseConvId } from "@/shared/conversations/id";
import type { User } from "@/shared/types/api";
import {
  isStoredEditable,
  parseStoredPostContent,
} from "@/server/services/postContent";
import type { AuditService } from "@/server/services/auditService";

export class PostActorFacade {
  constructor(
    private readonly actor: Actor,
    private readonly posts: PostService,
    private readonly groups: GroupService,
    private readonly audit: AuditService,
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

  async list(input: PostListInput) {
    const user = await this.actor.requireUser();
    if (input.type === "conversation") {
      if (!input.conv_id) throw new PublicError("缺少会话 ID");
      this.requireConversationAccess(user, input.conv_id);
    }
    return this.posts.list(user.id, input);
  }

  async get(postId: string) {
    const user = await this.actor.requireUser();
    this.requirePostAccess(user, postId);
    return this.posts.get(postId);
  }

  async create(raw: CreatePostInput, opts?: { deferNotify?: boolean }) {
    const user = await this.actor.requireUser();
    if (user.is_muted) throw new PublicError("你已被禁言");
    const input = this.posts.normalizeCreate(raw);
    const conversation = parseConvId(input.conv_id);
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
    if (input.reply_to) {
      const reply = this.requirePostAccess(user, input.reply_to);
      if (reply.deleted_at) throw new PublicError("被引用的帖子已删除");
      if (reply.conv_id !== input.conv_id) {
        throw new PublicError("引用帖与目标会话不匹配");
      }
    }
    return this.posts.create(user.id, input, {
      ...opts,
      authorizedDirectPeerId,
    });
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
      return result;
    }
    return this.posts.softDelete(postId);
  }
}
