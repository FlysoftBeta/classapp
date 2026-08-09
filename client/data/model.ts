import type { ArticleWithMeta, Group, Post, User } from "@/shared/types/api";

export type EvictionTier = 0 | 1 | 2;

export type StoredPost = Post & {
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

export interface ObjectiveDm {
  conv_id: string;
  peer_a: string;
  peer_b: string;
  revision: number;
  created_at?: string;
  touched_at: number;
}

export interface ObjectiveArticle {
  id: string;
  value: Omit<
    ArticleWithMeta,
    | "is_bookmarked"
    | "bookmark_updated_at_ms"
    | "current_offset"
    | "current_offset_updated_at"
    | "current_locator"
    | "total_read_seconds"
    | "last_read_at"
    | "list_sort_at"
    | "content"
  >;
  group_id: string;
  created_at: string;
  size: number;
  touched_at: number;
  eviction_tier: EvictionTier;
}

export interface ObjectiveUser {
  id: string;
  handle: string;
  name: string;
}

export interface MeRow {
  me_id: string;
  user: User;
  session_token: string | null;
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
      handle: string;
      username: string;
      hide_self?: number;
    }>;
    hidden: boolean;
    no_leave: boolean;
    self_hide_self: boolean;
  };
  snapshot_at: number;
}

export type AccessRow =
  | ConversationAccessRow
  | ArticleAccessRow
  | GroupMembersAccessRow;

export interface AssignmentBase<T> {
  value: T;
  updated_at: number;
}

export interface AssignmentProposal<T> extends AssignmentBase<T> {
  operation_id: string;
}

export interface Assignment<T> {
  base: AssignmentBase<T>;
  proposal: AssignmentProposal<T> | null;
}

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

export interface PostCoverage {
  scope: string;
  kind: "posts";
  conv_id: string;
  known_revision: number;
  lower: { id: string; sequence: number } | null;
  upper: { id: string; sequence: number } | null;
  reached_oldest: boolean;
  reached_newest: boolean;
  updated_at: number;
}

export interface SnapshotCoverage {
  scope: string;
  kind: "conversation-snapshot" | "article-list" | "group-members";
  me_id: string;
  complete: boolean;
  updated_at: number;
  detail?: unknown;
}

export type SyncRow = PostCoverage | SnapshotCoverage;

export interface RetentionRow {
  claimant: string;
  kind: "conversation" | "article";
  object_id: string;
  mode: string;
  keep_after_ms: number | null;
  protected_until: number;
  materialized: boolean;
  bytes: number;
  last_touched_at: number;
  missing_reason: "never-downloaded" | "evicted" | "failed" | null;
}
