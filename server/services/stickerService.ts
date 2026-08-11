import type { Database } from "better-sqlite3";
import {
  getStickerEntry,
  listStickerPackIds,
  loadStickerPack,
  parseRecentStickers,
  pushRecentSticker,
  sanitizeStickerId,
  sanitizeStickerPackId,
} from "@/server/infra/stickerLoader";
import { USER_CONFIG } from "@/shared/userConfig/keys";
import type { StickerRecentItem } from "@/shared/types/api";
import {
  PublicError,
  ContractViolationError,
} from "@/server/services/incidentService";
import { getUserConfig, setUserConfig } from "@/server/services/userConfig";

export class StickerService {
  constructor(private readonly db: Database) {}

  listPacks() {
    return listStickerPackIds().map((id) => {
      const pack = loadStickerPack(id);
      return {
        id,
        name: pack?.name ?? id,
        count: pack ? Object.keys(pack.stickers).length : 0,
      };
    });
  }

  getPack(packId: string) {
    const safeId = sanitizeStickerPackId(packId);
    if (!safeId) {
      throw new PublicError("贴纸包不存在");
    }
    const pack = loadStickerPack(safeId);
    if (!pack) {
      throw new PublicError("贴纸包不存在");
    }
    return pack;
  }

  getRecent(userId: string) {
    return this.readRecent(userId);
  }

  touchRecent(userId: string, pack: string, stickerId: string) {
    const safePack = sanitizeStickerPackId(pack);
    const safeId = sanitizeStickerId(stickerId);
    if (!safePack || !safeId) {
      throw new ContractViolationError("贴纸参数无效");
    }
    if (!getStickerEntry(safePack, safeId)) {
      throw new PublicError("贴纸不存在");
    }
    const existing = parseRecentStickers(
      getUserConfig(this.db, userId, USER_CONFIG.RECENT_STICKERS),
    );
    const next = pushRecentSticker(existing, { pack: safePack, id: safeId });
    setUserConfig(
      this.db,
      userId,
      USER_CONFIG.RECENT_STICKERS,
      JSON.stringify(next),
    );
    return this.readRecent(userId);
  }

  private readRecent(userId: string) {
    const refs = parseRecentStickers(
      getUserConfig(this.db, userId, USER_CONFIG.RECENT_STICKERS),
    );
    return refs
      .map((ref) => {
        const entry = getStickerEntry(ref.pack, ref.id);
        if (!entry) {
          return null;
        }
        return {
          pack: entry.pack,
          id: entry.id,
          name: entry.name,
          path: entry.path,
        };
      })
      .filter((item): item is StickerRecentItem => item !== null);
  }
}

export function createStickerService(db: Database): StickerService {
  return new StickerService(db);
}
