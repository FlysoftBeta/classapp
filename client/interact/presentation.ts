import type {
  ArticleWithMeta,
  ConversationEntity,
  PostEntity,
} from "@/shared/types/api";

export type Post = PostEntity & {
  username?: string | null;
  handle?: string | null;
  reply_username?: string | null;
  reply_handle?: string | null;
};

export type TextPost = Extract<Post, { type: "text" }>;
export type StickerPost = Extract<Post, { type: "sticker" }>;
export type ImagePost = Extract<Post, { type: "image" }>;
export type DeletedPost = Extract<Post, { type: "deleted" }>;

export type PostStreamEvent =
  | { kind: "post.created" | "post.updated"; data?: { post: Post } }
  | { kind: "post.deleted"; data?: { post: Post } };

export type Article = ArticleWithMeta & {
  username?: string | null;
  handle?: string | null;
};

export type Conversation = ConversationEntity & {
  handle: string | null;
  name: string;
};
