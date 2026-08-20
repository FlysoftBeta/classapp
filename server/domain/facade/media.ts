import type { Actor } from "@/server/runtime/actor";
import type { AuditService } from "@/server/services/auditService";
import type { MediaService } from "@/server/services/mediaService";
import type { MediaPlaylistService } from "@/server/services/mediaPlaylistService";
import type { AccessService } from "@/server/services/accessService";
import type { OwnerlessCapabilityService } from "@/server/services/ownerlessCapability";
import { PublicError } from "@/server/services/incidentService";
import type { AccessGrant, PrincipalRef } from "@/shared/access";
import type { SignedMediaTrack } from "@/shared/media/types";

/**
 * Public media entry points. Playlist access is derived from materialized
 * principal×resource bindings. Tracks are ownerless and require a capability.
 */
export class MediaActorFacade {
  constructor(
    private readonly actor: Actor,
    private readonly media: MediaService,
    private readonly lists: MediaPlaylistService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly ownerless: OwnerlessCapabilityService,
  ) {}

  private requireUser() {
    return this.actor.requireFeature("media");
  }

  async search(query: string, limit: number) {
    const user = this.requireUser();
    const tracks = await this.media.search(query, limit);
    return {
      tracks: tracks.map((track) => {
        const capability = this.ownerless.issue("track", track.id, {
          type: "search",
        });
        this.ownerless.remember(user.id, "track", track.id, capability);
        return { track, capability };
      }),
    };
  }

  async ensureTrack(input: {
    source: string;
    providerId: string;
    canonicalUrl?: string;
  }) {
    const user = this.requireUser();
    const track = this.media.ensureTrack({
      source: input.source,
      providerId: input.providerId,
      canonicalUrl:
        input.canonicalUrl ??
        `https://music.youtube.com/watch?v=${encodeURIComponent(input.providerId)}`,
      title: input.providerId,
      artists: [],
      album: null,
      durationMs: 0,
      thumbnailUrl: null,
    });
    const capability = this.ownerless.issue("track", track.id, {
      type: "search",
    });
    this.ownerless.remember(user.id, "track", track.id, capability);
    return { track, capability };
  }

  queue() {
    const user = this.requireUser();
    return this.lists.queue(user.id);
  }

  addToQueue(trackId: string, capability?: string) {
    const user = this.requireUser();
    if (!this.media.track(trackId)) throw new PublicError("曲目不存在");
    this.ownerless.require(user.id, "track", trackId, capability);
    const snapshot = this.lists.addToQueue(user.id, trackId);
    this.media.prepare(trackId);
    return snapshot;
  }

  removeFromQueue(trackId: string) {
    const user = this.requireUser();
    return this.lists.removeFromQueue(user.id, trackId);
  }

  clearQueue() {
    const user = this.requireUser();
    return this.lists.clearQueue(user.id);
  }

  play(trackId: string, capability?: string) {
    const user = this.requireUser();
    this.ownerless.require(user.id, "track", trackId, capability);
    this.media.recordRecent(user.id, trackId);
    return this.media.play(user.id, trackId);
  }

  playlists() {
    const user = this.requireUser();
    return { playlists: this.lists.playlists(user.id) };
  }

  playlist(playlistId: string) {
    const user = this.requireUser();
    return this.lists.playlist(user.id, playlistId);
  }

  createPlaylist(title: string) {
    const user = this.requireUser();
    return this.lists.create(user.id, title.trim() || "新播放列表");
  }

  deletePlaylist(playlistId: string) {
    const user = this.requireUser();
    this.lists.delete(user.id, playlistId);
  }

  addToPlaylist(playlistId: string, trackId: string, capability?: string) {
    const user = this.requireUser();
    if (!this.media.track(trackId)) throw new PublicError("曲目不存在");
    this.ownerless.require(user.id, "track", trackId, capability);
    return this.lists.addTrack(user.id, playlistId, trackId);
  }

  removeFromPlaylist(playlistId: string, trackId: string) {
    const user = this.requireUser();
    return this.lists.removeTrack(user.id, playlistId, trackId);
  }

  updatePlaylistRetention(playlistId: string, days: number) {
    const user = this.requireUser();
    return this.lists.updateRetention(user.id, playlistId, days);
  }

  grantPlaylistAccess(
    playlistId: string,
    principal: PrincipalRef,
    grant: AccessGrant,
  ) {
    const user = this.requireUser();
    this.access.grant(user.id, "playlist", playlistId, principal, grant);
    return this.lists.playlist(user.id, playlistId);
  }

  revokePlaylistAccess(playlistId: string, principal: PrincipalRef) {
    const user = this.requireUser();
    this.access.revoke(user.id, "playlist", playlistId, principal);
    return this.lists.playlist(user.id, playlistId);
  }

  playlistBindings(playlistId: string) {
    const user = this.requireUser();
    this.access.authorize(user.id, "playlist", playlistId, "read");
    return {
      bindings: this.access.listBindings("playlist", playlistId).map((row) => ({
        principal: row.principal,
        grants: row.grants,
        flags: row.flags,
      })),
    };
  }

  library() {
    const user = this.requireUser();
    const recentIds = this.media.listRecents(user.id);
    const favoriteIds = this.media.listFavorites(user.id);
    return {
      recents: this.presentTracks(user.id, recentIds),
      favorites: this.presentTracks(user.id, favoriteIds),
      playlists: this.lists.playlists(user.id),
    };
  }

  private presentTracks(userId: string, ids: string[]): SignedMediaTrack[] {
    const byId = new Map(
      this.media.tracks(ids).map((track) => [track.id, track]),
    );
    const rows: SignedMediaTrack[] = [];
    for (const id of ids) {
      const track = byId.get(id);
      if (!track) continue;
      const capability = this.ownerless.peek(userId, "track", id);
      if (!capability) continue;
      rows.push({ track, capability });
    }
    return rows;
  }

  setTrackFavorite(
    trackId: string,
    favorited: boolean,
    updatedAt: number,
    capability?: string,
  ) {
    const user = this.requireUser();
    this.ownerless.require(user.id, "track", trackId, capability);
    return this.media.setFavorite(user.id, trackId, favorited, updatedAt);
  }

  config() {
    this.requireUser();
    return this.media.config();
  }

  adminUpdateConfig(input: {
    max_volume?: number;
    eviction_days?: number;
    storage_limit_bytes?: number;
  }) {
    const admin = this.actor.requireRole("community_manager");
    const config = this.media.updateConfig(input);
    this.audit.record({
      actorId: admin.id,
      action: "media.config_update",
      targetKind: "config",
      targetId: "media",
      details: input,
    });
    return config;
  }
}
