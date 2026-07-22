import { LONG_TEXT_THRESHOLD } from "@/shared/validation/posts";
import { getStickerEntry } from "@/server/infra/stickerLoader";
import { stickerBrief } from "@/shared/posts/brief";
import type { CreatePostPayload } from "@/shared/validation/posts";

// ── 存储层（content_json，不向外暴露）────────────────────────────────────────

type StoredTextInline = { type: "text"; text_same_as_brief: true };
type StoredTextBody = { type: "text"; text: string };
type StoredSticker = {
  type: "sticker";
  sticker_pack: string;
  sticker_id: string;
};
type StoredPostContent = StoredTextInline | StoredTextBody | StoredSticker;

function isStoredPostContent(value: unknown): value is StoredPostContent {
  if (!value || typeof value !== "object") return false;
  const t = (value as { type?: unknown }).type;
  if (t === "text") {
    const v = value as StoredTextInline | StoredTextBody;
    if ("text_same_as_brief" in v && v.text_same_as_brief === true) return true;
    return typeof (v as StoredTextBody).text === "string";
  }
  if (t === "sticker") {
    const v = value as StoredSticker;
    return (
      typeof v.sticker_pack === "string" &&
      typeof v.sticker_id === "string" &&
      v.sticker_pack.length > 0 &&
      v.sticker_id.length > 0
    );
  }
  return false;
}

export function parseStoredPostContent(
  raw: string | null | undefined,
): StoredPostContent | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isStoredPostContent(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function serializeStoredPostContent(content: StoredPostContent): string {
  return JSON.stringify(content);
}

const EMPTY_STORED: StoredTextInline = {
  type: "text",
  text_same_as_brief: true,
};

export function emptyStoredPostContent(): string {
  return serializeStoredPostContent(EMPTY_STORED);
}

/** 从 DB 行读取存储形态；解析失败时视为短文本 inline。 */
export function loadStoredContent(row: {
  brief: string;
  content_json: string;
}): StoredPostContent {
  const parsed = parseStoredPostContent(row.content_json);
  if (parsed) return parsed;
  return EMPTY_STORED;
}

/** 纯文本 → 存储形态 */
export function encodeTextBody(text: string): {
  brief: string;
  stored: StoredPostContent;
} {
  const trimmed = text.trim();
  if (trimmed.length <= LONG_TEXT_THRESHOLD) {
    return {
      brief: trimmed,
      stored: { type: "text", text_same_as_brief: true },
    };
  }
  return {
    brief: trimmed.slice(0, LONG_TEXT_THRESHOLD),
    stored: { type: "text", text: trimmed },
  };
}

export function encodeCreatePayload(payload: CreatePostPayload): {
  brief: string;
  stored: StoredPostContent;
} {
  switch (payload.type) {
    case "text":
      return encodeTextBody(payload.text);
    case "sticker": {
      const entry = getStickerEntry(payload.sticker_pack, payload.sticker_id);
      if (!entry) throw new Error("sticker not found");
      return {
        brief: stickerBrief(entry.name),
        stored: {
          type: "sticker",
          sticker_pack: entry.pack,
          sticker_id: entry.id,
        },
      };
    }
  }
}

export function isStoredEditable(stored: StoredPostContent | null): boolean {
  return stored?.type === "text";
}

export function resolveStoredText(
  brief: string,
  stored: StoredPostContent,
): string {
  if (stored.type !== "text") return brief;
  if ("text_same_as_brief" in stored) return brief;
  return stored.text;
}
