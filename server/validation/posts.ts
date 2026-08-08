import { ServiceError } from "@/server/services/errors";
import {
  encodeCreatePayload,
  encodeTextBody,
  serializeStoredPostContent,
} from "@/server/services/postContent";
import {
  isCreatePostPayload,
  type CreatePostPayload,
} from "@/shared/validation/posts";
import { getStickerEntry } from "@/server/infra/stickerLoader";

export interface CreatePostInput {
  /** 纯文本 string，或结构化 payload；brief 由服务端生成 */
  content?: CreatePostPayload | string;
  conv_id?: string;
  reply_to?: string;
}

export interface NormalizedCreatePost {
  brief: string;
  content_json: string;
  conv_id: string;
  reply_to: string | null;
}

function normalizeBody(raw: CreatePostInput): {
  brief: string;
  content_json: string;
} {
  if (typeof raw.content === "string") {
    const { brief, stored } = encodeTextBody(raw.content);
    return {
      brief,
      content_json: serializeStoredPostContent(stored),
    };
  }

  if (raw.content && isCreatePostPayload(raw.content)) {
    if (raw.content.type === "sticker") {
      if (!getStickerEntry(raw.content.sticker_pack, raw.content.sticker_id)) {
        throw new ServiceError("贴纸不存在");
      }
    }

    const encoded = encodeCreatePayload(raw.content);
    return {
      brief: encoded.brief,
      content_json: serializeStoredPostContent(encoded.stored),
    };
  }

  throw new ServiceError("内容不能为空");
}

export function normalizeCreatePost(
  raw: CreatePostInput,
): NormalizedCreatePost {
  const conv_id = raw.conv_id?.trim();
  if (!conv_id) throw new ServiceError("必须指定会话");

  const body = normalizeBody(raw);

  return {
    ...body,
    conv_id,
    reply_to: raw.reply_to?.trim() || null,
  };
}

export function normalizeUpdatePost(text: string): {
  brief: string;
  content_json: string;
} {
  const { brief, stored } = encodeTextBody(text);
  return { brief, content_json: serializeStoredPostContent(stored) };
}
