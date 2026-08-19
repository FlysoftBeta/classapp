import type BetterSqlite3 from "better-sqlite3";
import {
  acknowledgeAnnouncement,
  getAnnouncement,
  isAnnouncementAcknowledged,
  updateAnnouncement,
} from "@/server/data/announcement";
import { publishSystem } from "@/server/runtime/eventBus";

export class AnnouncementService {
  constructor(private readonly db: BetterSqlite3.Database) {}
  get() {
    return getAnnouncement(this.db);
  }
  update(content: string) {
    const announcement = updateAnnouncement(this.db, content);
    publishSystem({
      kind: "system.announcement_changed",
      data: { revision: announcement.revision },
    });
    return announcement;
  }
  getForUser(userId: string) {
    const announcement = this.get();
    return {
      ...announcement,
      acknowledged:
        !announcement.content ||
        isAnnouncementAcknowledged(this.db, userId, announcement.revision),
    };
  }
  acknowledge(userId: string, revision: number) {
    return acknowledgeAnnouncement(this.db, userId, revision);
  }
}
export const createAnnouncementService = (db: BetterSqlite3.Database) =>
  new AnnouncementService(db);
