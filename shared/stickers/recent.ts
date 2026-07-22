import {
  sanitizeStickerId,
  sanitizeStickerPackId,
} from "@/shared/validation/stickers";

export const RECENT_STICKERS_MAX = 32;

export interface RecentStickerRef {
  pack: string;
  id: string;
}

/** Parse stored JSON into validated sticker refs (structure only, no fs check). */
export function parseRecentStickerRefs(
  raw: string | null | undefined,
): RecentStickerRef[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: RecentStickerRef[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const pack = sanitizeStickerPackId(
        String((item as { pack?: unknown }).pack ?? ""),
      );
      const id = sanitizeStickerId(String((item as { id?: unknown }).id ?? ""));
      if (!pack || !id) continue;
      if (out.some((x) => x.pack === pack && x.id === id)) continue;
      out.push({ pack, id });
      if (out.length >= RECENT_STICKERS_MAX) break;
    }
    return out;
  } catch {
    return [];
  }
}

export function pushRecentSticker(
  list: RecentStickerRef[],
  ref: RecentStickerRef,
): RecentStickerRef[] {
  const filtered = list.filter(
    (x) => !(x.pack === ref.pack && x.id === ref.id),
  );
  return [ref, ...filtered].slice(0, RECENT_STICKERS_MAX);
}
