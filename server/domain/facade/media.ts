import type { Actor } from "@/server/runtime/actor";
import type { AuditService } from "@/server/services/auditService";
import type { MediaService } from "@/server/services/mediaService";
import type { MediaPlaylistService } from "@/server/services/mediaPlaylistService";
import { PublicError } from "@/server/services/incidentService";

/**
 * Public media entry points. Queue/playlist ownership is always derived from
 * the authenticated user, never from a client-provided owner id.
 */
export class MediaActorFacade {
  constructor(
    private readonly actor: Actor,
    private readonly media: MediaService,
    private readonly lists: MediaPlaylistService,
    private readonly audit: AuditService,
  ) {}

  private requireUser() {
    return this.actor.requireFeature("media");
  }

  async search(query: string, limit: number) {
    this.requireUser();
    const tracks = await this.media.search(query, limit);
    return { tracks };
  }

  async ensureTrack(input: {
    source: string;
    providerId: string;
    canonicalUrl?: string;
  }) {
    this.requireUser();
    return {
      track: this.media.ensureTrack({
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
      }),
    };
  }

  queue() {
    const user = this.requireUser();
    return this.lists.queue(user.id);
  }

  addToQueue(trackId: string) {
    const user = this.requireUser();
    const track = this.media.track(trackId);
    if (!track) throw new PublicError("曲目不存在");
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

  play(trackId: string) {
    const user = this.requireUser();
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

  addToPlaylist(playlistId: string, trackId: string) {
    const user = this.requireUser();
    if (!this.media.track(trackId)) throw new PublicError("曲目不存在");
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
