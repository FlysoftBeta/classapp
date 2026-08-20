import type {
  AppDisableState,
  ArticleWithMeta,
  Group,
  PostEntity,
  User,
} from "@/shared/types/api";
import type { Article } from "@/client/interact/presentation";
import type { ContinuousCoverage } from "@/client/repo/coverage";
import type { Assignment } from "@/client/repo/assignment";

export type EvictionTier = 0 | 1 | 2;

export type StoredPost = PostEntity & {
  sequence: number;
  size: number;
  touched_at: number;
  eviction_tier: EvictionTier;
};

export interface StoredArticleSegment<T = unknown> {
  article_id: string;
  start_offset: number;
  value: T;
  size: number;
  touched_at: number;
  eviction_tier: EvictionTier;
}

export interface ObjectiveGroup extends Group {
  touched_at: number;
}

export interface StoredGroup {
  id: string;
  conv_id: string;
  revision: number;
  handle: string;
  name: string;
  group_type: string;
  has_password: number;
  members_hidden: number;
  admin_only: number;
  no_leave: number;
  last_message: string | null;
  last_at: string | null;
  touched_at: number;
}

export interface ObjectiveDm {
  conv_id: string;
  peer_a: string;
  peer_b: string;
  revision: number;
  created_at?: string;
  touched_at: number;
}

export interface StoredDm {
  conv_id: string;
  revision: number;
  peer_a: string;
  peer_b: string;
  last_message: string | null;
  last_at: string | null;
  touched_at: number;
}

export interface ObjectiveArticle {
  id: string;
  value: Pick<
    ArticleWithMeta,
    | "id"
    | "user_id"
    | "group_id"
    | "title"
    | "provider"
    | "content_kind"
    | "mime_type"
    | "file_size"
    | "original_filename"
    | "created_at"
    | "content_length"
  >;
  group_id: string | null;
  created_at: string;
  size: number;
  touched_at: number;
  eviction_tier: EvictionTier;
}

export type MaterializedArticle = Article;

export interface ObjectiveUser {
  id: string;
  revision: number;
  handle: string | null;
  username: string;
}

export interface MeRow {
  me_id: string;
  user: User;
  session_token: string | null;
  konami_lock: Assignment<boolean>;
  app_disable: AppDisableState;
  system_locked: boolean;
  updated_at: number;
}

export interface ConversationAccessRow {
  me_id: string;
  kind: "conversation";
  object_id: string;
  type: "group" | "dm";
  target_id: string;
  capabilities: {
    can_post: boolean;
    can_leave: boolean;
  };
  snapshot_at: number;
}

export interface ArticleMembership {
  view: "all" | "bookmarked" | "recent" | "sidebar" | "direct";
  group_id: string | null;
  sort_at: string;
}

export interface ArticleAccessRow {
  me_id: string;
  kind: "article";
  object_id: string;
  memberships: ArticleMembership[];
  snapshot_at: number;
}

export interface GroupMembersAccessRow {
  me_id: string;
  kind: "group-members";
  object_id: string;
  snapshot: {
    members: Array<{
      id: string;
      created_at?: string;
      joined_at?: string;
      hide_self?: number;
    }>;
    hidden: boolean;
    no_leave: boolean;
    self_hide_self: boolean;
  };
  snapshot_at: number;
}

export type AccessRow =
  ConversationAccessRow | ArticleAccessRow | GroupMembersAccessRow;

export interface ConversationUserStateRow {
  me_id: string;
  conv_id: string;
  read: Assignment<{ post_id: string | null; sequence: number }>;
  pinned: Assignment<boolean>;
  muted: Assignment<boolean>;
  draft: Assignment<string>;
  /** Derived by the server. This is a cache projection, not an offline proposal. */
  unread: {
    first_post_id: string | null;
    count: number;
    snapshot_revision: number;
  };
  pending: 0 | 1;
}

export interface ArticleUserStateRow {
  me_id: string;
  article_id: string;
  bookmark: Assignment<boolean>;
  resume: Assignment<number>;
  furthest: Assignment<number>;
  total_read_seconds: number;
  last_read_at: string | null;
  pending: 0 | 1;
}

export interface MeStateRow<T = unknown> {
  me_id: string;
  key: string;
  assignment: Assignment<T>;
  pending: 0 | 1;
}

export interface PostCoverage extends ContinuousCoverage<{
  id: string;
  order: number;
}> {
  scope: string;
  kind: "posts";
  conv_id: string;
  known_revision: number;
  revision_sum: string;
  reached_oldest: boolean;
  reached_newest: boolean;
  updated_at: number;
}

export interface ArticleListCoverage {
  scope: string;
  kind: "article-list";
  me_id: string;
  complete: boolean;
  updated_at: number;
  detail?: ContinuousCoverage<{ id: string; order: string }>;
}

export interface SnapshotCoverage {
  scope: string;
  kind: "conversation-snapshot" | "group-members";
  me_id: string;
  complete: boolean;
  updated_at: number;
  detail?: unknown;
}

export type SyncRow = PostCoverage | ArticleListCoverage | SnapshotCoverage;

export interface RetentionRow {
  claimant: string;
  kind: "conversation" | "article" | "media";
  object_id: string;
  mode: string;
  keep_after_ms: number | null;
  protected_until: number;
  materialized: boolean;
  bytes: number;
  last_touched_at: number;
  missing_reason: "never-downloaded" | "evicted" | "failed" | null;
}
