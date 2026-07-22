/** Pack id: ascii letters, digits, underscore, hyphen only. */
const PACK_ID_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * Sticker id: filename stem — no path separators or control chars.
 * Allows CJK and most printable Unicode in filenames.
 */
const STICKER_ID_RE = /^[^\0/\\]+$/;

export function sanitizeStickerPackId(raw: string): string | null {
  const id = raw.trim();
  if (!id || !PACK_ID_RE.test(id)) return null;
  if (id === "." || id === "..") return null;
  return id;
}

export function sanitizeStickerId(raw: string): string | null {
  const id = raw.trim();
  if (!id || !STICKER_ID_RE.test(id) || id.includes("..")) return null;
  return id;
}
