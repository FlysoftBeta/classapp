import { randomInt } from "crypto";
import type BetterSqlite3 from "better-sqlite3";
import {
  createGhostUserRecord,
  deleteGhostUserById,
  ghostPinHashExists,
  listGhostUsers,
} from "@/server/data/ghostUsers";
import { findUserPinOwnerId } from "@/server/data/users";
import { createPinHasher } from "@/server/infra/credentials";
import { PublicError } from "@/server/services/incidentService";

export interface GhostUserServiceDeps {
  generatePin: () => string;
  hashPinValue: (pin: string) => string;
}

function defaultDeps(db: BetterSqlite3.Database): GhostUserServiceDeps {
  return {
    generatePin: () => String(randomInt(100000, 1_000_000)),
    hashPinValue: createPinHasher(db),
  };
}

export class GhostUserService {
  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly deps: GhostUserServiceDeps,
  ) {}

  list() {
    return listGhostUsers(this.db);
  }

  create(): { pin: string; ghost_id: string } {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const pin = this.deps.generatePin();
      const pinHash = this.deps.hashPinValue(pin);
      if (
        ghostPinHashExists(this.db, pinHash) ||
        findUserPinOwnerId(this.db, pinHash)
      ) {
        continue;
      }
      return {
        pin,
        ghost_id: createGhostUserRecord(this.db, pinHash),
      };
    }
    throw new PublicError("生成的 PIN 冲突，请重试");
  }

  delete(id: string): void {
    if (!deleteGhostUserById(this.db, id)) {
      throw new PublicError("幽灵用户不存在");
    }
  }
}

export function createGhostUserService(
  db: BetterSqlite3.Database,
  deps: Partial<GhostUserServiceDeps> = {},
): GhostUserService {
  return new GhostUserService(db, { ...defaultDeps(db), ...deps });
}
