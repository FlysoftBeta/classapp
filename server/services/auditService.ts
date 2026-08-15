import type { Database } from "better-sqlite3";
import { insertAuditEntry, listAuditEntries } from "@/server/data/audit";

/** Structured records of successful administrative decisions. */
export class AuditService {
  constructor(private readonly db: Database) {}

  record(input: {
    actorId: string;
    action: string;
    targetKind: string;
    targetId?: string | null;
    details?: Record<string, unknown>;
  }): void {
    insertAuditEntry(this.db, input);
  }

  list(offset = 0) {
    return { entries: listAuditEntries(this.db, offset, 100) };
  }
}

export function createAuditService(db: Database): AuditService {
  return new AuditService(db);
}
