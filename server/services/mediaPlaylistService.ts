import type { Database } from "better-sqlite3";
import {
  addPlaylistItem,
  addQueueItem,
  clearQueue,
  createPlaylist,
  deletePlaylist,
  listPlaylists,
  playlistSnapshot,
  queueSnapshot,
  removePlaylistItem,
  removeQueueItem,
  updatePlaylistRetention,
} from "@/server/data/media";
import { publishUser } from "@/server/services/eventBus";
import { PublicError } from "@/server/services/incidentService";
import type { MediaListSnapshot } from "@/shared/media/types";

/** Objective list mechanics. Actor ownership is checked by the Facade. */
export class MediaPlaylistService {
  constructor(private readonly db: Database) {}

  private publishQueue(userId: string, snapshot: MediaListSnapshot): void {
    publishUser(userId, {
      kind: "media.queue.changed",
      data: { revision: snapshot.list.revision },
    });
  }

  queue(userId: string): MediaListSnapshot {
    return queueSnapshot(this.db, userId);
  }

  addToQueue(userId: string, trackId: string): MediaListSnapshot {
    const snapshot = this.db.transaction(() =>
      addQueueItem(this.db, userId, trackId),
    )();
    this.publishQueue(userId, snapshot);
    return snapshot;
  }

  removeFromQueue(userId: string, trackId: string): MediaListSnapshot {
    const snapshot = this.db.transaction(() =>
      removeQueueItem(this.db, userId, trackId),
    )();
    this.publishQueue(userId, snapshot);
    return snapshot;
  }

  clearQueue(userId: string): MediaListSnapshot {
    const snapshot = this.db.transaction(() =>
      clearQueue(this.db, userId),
    )();
    this.publishQueue(userId, snapshot);
    return snapshot;
  }

  playlists(userId: string) {
    return listPlaylists(this.db, userId);
  }

  playlist(userId: string, playlistId: string): MediaListSnapshot {
    try {
      return playlistSnapshot(this.db, userId, playlistId);
    } catch {
      throw new PublicError("播放列表不存在");
    }
  }

  create(userId: string, title: string): MediaListSnapshot {
    const snapshot = this.db.transaction(() =>
      createPlaylist(this.db, userId, title),
    )();
    publishUser(userId, {
      kind: "media.playlist.changed",
      data: { playlist_id: snapshot.list.id, revision: snapshot.list.revision },
    });
    return snapshot;
  }

  addTrack(
    userId: string,
    playlistId: string,
    trackId: string,
  ): MediaListSnapshot {
    try {
      const snapshot = this.db.transaction(() =>
        addPlaylistItem(this.db, userId, playlistId, trackId),
      )();
      publishUser(userId, {
        kind: "media.playlist.changed",
        data: { playlist_id: playlistId, revision: snapshot.list.revision },
      });
      return snapshot;
    } catch (error) {
      if (error instanceof Error && error.message === "playlist not found") {
        throw new PublicError("播放列表不存在");
      }
      throw error;
    }
  }

  removeTrack(
    userId: string,
    playlistId: string,
    trackId: string,
  ): MediaListSnapshot {
    try {
      const snapshot = this.db.transaction(() =>
        removePlaylistItem(this.db, userId, playlistId, trackId),
      )();
      publishUser(userId, {
        kind: "media.playlist.changed",
        data: { playlist_id: playlistId, revision: snapshot.list.revision },
      });
      return snapshot;
    } catch (error) {
      if (error instanceof Error && error.message === "playlist not found") {
        throw new PublicError("播放列表不存在");
      }
      throw error;
    }
  }

  updateRetention(
    userId: string,
    playlistId: string,
    days: number,
  ): MediaListSnapshot {
    try {
      const snapshot = this.db.transaction(() =>
        updatePlaylistRetention(this.db, userId, playlistId, days),
      )();
      publishUser(userId, {
        kind: "media.playlist.changed",
        data: { playlist_id: playlistId, revision: snapshot.list.revision },
      });
      return snapshot;
    } catch (error) {
      if (error instanceof Error && error.message === "playlist not found") {
        throw new PublicError("播放列表不存在");
      }
      throw error;
    }
  }

  delete(userId: string, playlistId: string): void {
    try {
      this.db.transaction(() => deletePlaylist(this.db, userId, playlistId))();
    } catch (error) {
      if (error instanceof Error && error.message === "playlist not found") {
        throw new PublicError("播放列表不存在");
      }
      throw error;
    }
    publishUser(userId, {
      kind: "media.playlist.changed",
      data: { playlist_id: playlistId, revision: 0 },
    });
  }
}
