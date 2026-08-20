import type { Database } from "better-sqlite3";
import {
  addPlaylistItemById,
  addQueueItem,
  clearQueue,
  createPlaylistRow,
  deletePlaylistById,
  listPlaylistsByIds,
  playlistSnapshotById,
  queueSnapshot,
  removePlaylistItemById,
  removeQueueItem,
  updatePlaylistRetentionById,
  type MediaListContents,
} from "@/server/data/media";
import { touchRecent } from "@/server/data/preferences";
import { publishUser } from "@/server/runtime/eventBus";
import { PublicError } from "@/server/services/incidentService";
import type { AccessService } from "@/server/services/accessService";
import type { OwnerlessCapabilityService } from "@/server/services/ownerlessCapability";
import type {
  MediaListSnapshot,
  MediaPlaylistSummary,
  SignedMediaTrack,
} from "@/shared/media/types";
import { collectionSource, type AccessFlags, type CapabilitySource } from "@/shared/access";
import { AuthorizationError } from "@/server/services/authorizationError";

function signContents(
  ownerless: OwnerlessCapabilityService,
  userId: string,
  contents: MediaListContents,
  source: CapabilitySource,
  flags: AccessFlags,
): MediaListSnapshot {
  const tracks: SignedMediaTrack[] = contents.tracks.map((track) => {
    const capability = ownerless.issue("track", track.id, source);
    ownerless.remember(userId, "track", track.id, capability);
    return { track, capability };
  });
  return {
    list: { ...contents.list, access: flags },
    items: contents.items,
    tracks,
  };
}

/** Objective list mechanics. Actor access is checked here via AccessService. */
export class MediaPlaylistService {
  constructor(
    private readonly db: Database,
    private readonly access: AccessService,
    private readonly ownerless: OwnerlessCapabilityService,
  ) {}

  private publishQueue(userId: string, snapshot: MediaListSnapshot): void {
    publishUser(userId, {
      kind: "media.queue.changed",
      data: { revision: snapshot.list.revision },
    });
  }

  private publishPlaylist(userId: string, snapshot: MediaListSnapshot): void {
    publishUser(userId, {
      kind: "media.playlist.changed",
      data: { playlist_id: snapshot.list.id, revision: snapshot.list.revision },
    });
  }

  private ensureQueue(userId: string): MediaListContents {
    const contents = queueSnapshot(this.db, userId);
    this.access.bindOwner("queue", contents.list.id, {
      kind: "user",
      id: userId,
    });
    return contents;
  }

  private signedQueue(userId: string): MediaListSnapshot {
    const contents = this.ensureQueue(userId);
    const auth = this.access.authorize(
      userId,
      "queue",
      contents.list.id,
      "read",
    );
    return signContents(
      this.ownerless,
      userId,
      contents,
      collectionSource("queue", contents.list.id),
      auth.flags,
    );
  }

  private signedPlaylist(userId: string, playlistId: string): MediaListSnapshot {
    const auth = this.access.authorize(userId, "playlist", playlistId, "read");
    const contents = playlistSnapshotById(this.db, playlistId);
    touchRecent(this.db, userId, "playlist", playlistId);
    return signContents(
      this.ownerless,
      userId,
      contents,
      collectionSource("playlist", playlistId, contents.list.revision),
      auth.flags,
    );
  }

  queue(userId: string): MediaListSnapshot {
    return this.signedQueue(userId);
  }

  addToQueue(userId: string, trackId: string): MediaListSnapshot {
    const snapshot = this.db.transaction(() => {
      this.access.authorize(
        userId,
        "queue",
        this.ensureQueue(userId).list.id,
        "write",
      );
      addQueueItem(this.db, userId, trackId);
      return this.signedQueue(userId);
    })();
    this.publishQueue(userId, snapshot);
    return snapshot;
  }

  removeFromQueue(userId: string, trackId: string): MediaListSnapshot {
    const snapshot = this.db.transaction(() => {
      this.access.authorize(
        userId,
        "queue",
        this.ensureQueue(userId).list.id,
        "write",
      );
      removeQueueItem(this.db, userId, trackId);
      return this.signedQueue(userId);
    })();
    this.publishQueue(userId, snapshot);
    return snapshot;
  }

  clearQueue(userId: string): MediaListSnapshot {
    const snapshot = this.db.transaction(() => {
      this.access.authorize(
        userId,
        "queue",
        this.ensureQueue(userId).list.id,
        "write",
      );
      clearQueue(this.db, userId);
      return this.signedQueue(userId);
    })();
    this.publishQueue(userId, snapshot);
    return snapshot;
  }

  playlists(userId: string): MediaPlaylistSummary[] {
    const ids = this.access.listAccessibleIds(userId, "playlist");
    return listPlaylistsByIds(this.db, ids).map((list) => ({
      ...list,
      access: this.access.peek(userId, "playlist", list.id),
    }));
  }

  playlist(userId: string, playlistId: string): MediaListSnapshot {
    try {
      return this.signedPlaylist(userId, playlistId);
    } catch (error) {
      if (error instanceof AuthorizationError) throw error;
      throw new PublicError("播放列表不存在");
    }
  }

  create(userId: string, title: string): MediaListSnapshot {
    const snapshot = this.db.transaction(() => {
      const id = createPlaylistRow(this.db, title);
      this.access.bindOwner("playlist", id, { kind: "user", id: userId });
      return this.signedPlaylist(userId, id);
    })();
    this.publishPlaylist(userId, snapshot);
    return snapshot;
  }

  addTrack(
    userId: string,
    playlistId: string,
    trackId: string,
  ): MediaListSnapshot {
    try {
      const snapshot = this.db.transaction(() => {
        this.access.authorize(userId, "playlist", playlistId, "write");
        addPlaylistItemById(this.db, playlistId, trackId);
        return this.signedPlaylist(userId, playlistId);
      })();
      this.publishPlaylist(userId, snapshot);
      return snapshot;
    } catch (error) {
      if (error instanceof AuthorizationError) throw error;
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
      const snapshot = this.db.transaction(() => {
        this.access.authorize(userId, "playlist", playlistId, "write");
        removePlaylistItemById(this.db, playlistId, trackId);
        return this.signedPlaylist(userId, playlistId);
      })();
      this.publishPlaylist(userId, snapshot);
      return snapshot;
    } catch (error) {
      if (error instanceof AuthorizationError) throw error;
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
      const snapshot = this.db.transaction(() => {
        this.access.authorize(userId, "playlist", playlistId, "write");
        updatePlaylistRetentionById(this.db, playlistId, days);
        return this.signedPlaylist(userId, playlistId);
      })();
      this.publishPlaylist(userId, snapshot);
      return snapshot;
    } catch (error) {
      if (error instanceof AuthorizationError) throw error;
      if (error instanceof Error && error.message === "playlist not found") {
        throw new PublicError("播放列表不存在");
      }
      throw error;
    }
  }

  delete(userId: string, playlistId: string): void {
    try {
      this.db.transaction(() => {
        this.access.authorize(userId, "playlist", playlistId, "own");
        this.access.dropResource("playlist", playlistId);
        deletePlaylistById(this.db, playlistId);
      })();
    } catch (error) {
      if (error instanceof AuthorizationError) throw error;
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
