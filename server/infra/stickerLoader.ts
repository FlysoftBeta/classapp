import fs from "fs";
import path from "path";
import {
  sanitizeStickerId,
  sanitizeStickerPackId,
} from "@/shared/validation/stickers";
import {
  parseRecentStickerRefs,
  type RecentStickerRef,
} from "@/shared/stickers/recent";
import { getRuntimeConfig } from "./runtimeConfig";

const STICKERS_ROOT = path.join(getRuntimeConfig().appDir, "public/stickers");

export interface StickerEntry {
  name: string;
  path: string;
}

export interface StickerPackManifest {
  id: string;
  name: string;
  stickers: Record<string, StickerEntry>;
}

export { sanitizeStickerPackId, sanitizeStickerId };

function packDir(packId: string): string {
  return path.join(STICKERS_ROOT, packId);
}

function packManifestPath(packId: string): string {
  return path.join(packDir(packId), "pack.json");
}

export function listStickerPackIds(): string[] {
  if (!fs.existsSync(STICKERS_ROOT)) return [];
  return fs
    .readdirSync(STICKERS_ROOT, { withFileTypes: true })
    .filter(
      (e) =>
        e.isDirectory() &&
        sanitizeStickerPackId(e.name) === e.name &&
        fs.existsSync(packManifestPath(e.name)),
    )
    .map((e) => e.name)
    .sort();
}

export function loadStickerPack(packId: string): StickerPackManifest | null {
  const safeId = sanitizeStickerPackId(packId);
  if (!safeId) return null;

  const manifestPath = packManifestPath(safeId);
  const resolvedRoot = path.resolve(STICKERS_ROOT);
  const resolvedManifest = path.resolve(manifestPath);
  if (!resolvedManifest.startsWith(resolvedRoot + path.sep)) return null;
  if (!fs.existsSync(resolvedManifest)) return null;

  try {
    const raw = JSON.parse(
      fs.readFileSync(resolvedManifest, "utf8"),
    ) as unknown;
    if (!raw || typeof raw !== "object") return null;
    const manifest = raw as StickerPackManifest;
    if (manifest.id !== safeId || typeof manifest.stickers !== "object") {
      return null;
    }
    return manifest;
  } catch {
    return null;
  }
}

export function getStickerEntry(
  packId: string,
  stickerId: string,
): (StickerEntry & { pack: string; id: string }) | null {
  const safePack = sanitizeStickerPackId(packId);
  const safeId = sanitizeStickerId(stickerId);
  if (!safePack || !safeId) return null;

  const pack = loadStickerPack(safePack);
  if (!pack) return null;

  const entry = pack.stickers[safeId];
  if (!entry || typeof entry.path !== "string") return null;

  const expectedPrefix = `/stickers/${safePack}/`;
  if (!entry.path.startsWith(expectedPrefix)) return null;

  const filename = entry.path.slice(expectedPrefix.length);
  if (
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("..")
  ) {
    return null;
  }

  const filePath = path.join(STICKERS_ROOT, safePack, filename);
  const resolvedFile = path.resolve(filePath);
  if (!resolvedFile.startsWith(path.resolve(packDir(safePack)) + path.sep)) {
    return null;
  }
  if (!fs.existsSync(resolvedFile)) return null;

  return {
    pack: safePack,
    id: safeId,
    name: entry.name || safeId,
    path: entry.path,
  };
}

export type { RecentStickerRef };
export { pushRecentSticker } from "@/shared/stickers/recent";

/** Parse stored refs and drop entries missing on disk. */
export function parseRecentStickers(
  raw: string | null | undefined,
): RecentStickerRef[] {
  return parseRecentStickerRefs(raw).filter(
    (ref) => getStickerEntry(ref.pack, ref.id) != null,
  );
}
