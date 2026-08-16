import {
  mediaAddToPlaylist,
  mediaAddToQueue,
  mediaClearQueue,
  mediaCreatePlaylist,
  mediaDeletePlaylist,
  mediaFetchConfig,
  mediaFetchPlaylist,
  mediaFetchQueue,
  mediaListPlaylists,
  mediaPlay,
  mediaRemoveFromPlaylist,
  mediaRemoveFromQueue,
  mediaSearch,
  mediaUpdatePlaylistRetention,
} from "@/client/api/media";
import {
  getMediaListSnapshot,
  listMediaPlaylists,
  listMediaPlaylistLastPlayed,
  putMediaListSnapshot,
  putMediaPlaylistLastPlayed,
  putMediaTracks,
} from "@/client/data/media";
import { captureActorContext, isActorContextCurrent } from "./actorContext";
import { useMediaStore } from "./mediaStore";
import { captureDetachedClientIncident } from "./clientIncidents";
import type {
  MediaListSnapshot,
  MediaPlaylistSummary,
  MediaTrack,
} from "@/shared/media/types";

function sortPlaylistsByLastPlayed(
  playlists: MediaPlaylistSummary[],
  lastPlayed: Record<string, string>,
): MediaPlaylistSummary[] {
  return [...playlists].sort((left, right) =>
    (lastPlayed[right.id] ?? right.updated_at).localeCompare(
      lastPlayed[left.id] ?? left.updated_at,
    ),
  );
}

export async function refreshMediaQueue(): Promise<void> {
  const actor = captureActorContext();
  try {
    const snapshot = await mediaFetchQueue();
    if (!isActorContextCurrent(actor)) return;
    await putMediaListSnapshot(actor.userId, "queue", snapshot);
    useMediaStore.getState().setQueue(snapshot);
  } catch (error) {
    const cached = useMediaStore.getState().queue;
    if (cached) {
      useMediaStore.getState().setQueue(cached);
      return;
    }
    if (!isActorContextCurrent(actor)) return;
    captureDetachedClientIncident("media.queue.refresh", error);
  }
}

export async function refreshMediaPlaylists(): Promise<void> {
  const actor = captureActorContext();
  try {
    const result = await mediaListPlaylists();
    if (!isActorContextCurrent(actor)) return;
    const lastPlayed = await listMediaPlaylistLastPlayed(actor.userId).catch(
      () => ({}),
    );
    if (!isActorContextCurrent(actor)) return;
    const store = useMediaStore.getState();
    store.setPlaylistLastPlayed(lastPlayed);
    store.setPlaylists(sortPlaylistsByLastPlayed(result.playlists, lastPlayed));
  } catch (error) {
    try {
      const cached = await listMediaPlaylists(actor.userId);
      if (isActorContextCurrent(actor)) {
        useMediaStore.getState().setPlaylists(cached);
      }
    } catch {
      captureDetachedClientIncident("media.playlists.refresh", error);
    }
  }
}

export async function openMediaPlaylist(playlistId: string): Promise<void> {
  const actor = captureActorContext();
  try {
    const snapshot = await mediaFetchPlaylist(playlistId);
    if (!isActorContextCurrent(actor)) return;
    await putMediaListSnapshot(actor.userId, "playlist", snapshot);
    useMediaStore.getState().setCurrentPlaylist(snapshot);
  } catch (error) {
    const cached = await getMediaListSnapshot(
      actor.userId,
      "playlist",
      playlistId,
    );
    if (cached && isActorContextCurrent(actor)) {
      useMediaStore.getState().setCurrentPlaylist(cached);
      return;
    }
    captureDetachedClientIncident("media.playlist.open", error);
  }
}

export async function searchMedia(query: string): Promise<void> {
  const store = useMediaStore.getState();
  store.setSearchLoading(true);
  store.setSearchError(null);
  store.setSearchResults([]);
  try {
    const result = await mediaSearch(query, 20);
    await putMediaTracks(result.tracks);
    useMediaStore.getState().setSearchResults(result.tracks);
  } catch (error) {
    useMediaStore
      .getState()
      .setSearchError(error instanceof Error ? error.message : "搜索失败");
  } finally {
    useMediaStore.getState().setSearchLoading(false);
  }
}

export async function addTrackToQueue(trackId: string): Promise<void> {
  const actor = captureActorContext();
  try {
    const snapshot = await mediaAddToQueue(trackId);
    if (!isActorContextCurrent(actor)) return;
    await putMediaListSnapshot(actor.userId, "queue", snapshot);
    useMediaStore.getState().setQueue(snapshot);
  } catch (error) {
    captureDetachedClientIncident("media.queue.add", error);
  }
}

export async function removeTrackFromQueue(trackId: string): Promise<void> {
  const actor = captureActorContext();
  try {
    const snapshot = await mediaRemoveFromQueue(trackId);
    if (!isActorContextCurrent(actor)) return;
    await putMediaListSnapshot(actor.userId, "queue", snapshot);
    useMediaStore.getState().setQueue(snapshot);
  } catch (error) {
    captureDetachedClientIncident("media.queue.remove", error);
  }
}

export async function clearMediaQueue(): Promise<void> {
  const actor = captureActorContext();
  try {
    const snapshot = await mediaClearQueue();
    if (!isActorContextCurrent(actor)) return;
    await putMediaListSnapshot(actor.userId, "queue", snapshot);
    useMediaStore.getState().setQueue(snapshot);
  } catch (error) {
    captureDetachedClientIncident("media.queue.clear", error);
  }
}

export async function requestMediaPlay(trackId: string) {
  return mediaPlay(trackId);
}

export async function createMediaPlaylist(
  title: string,
): Promise<MediaListSnapshot | null> {
  const actor = captureActorContext();
  try {
    const snapshot = await mediaCreatePlaylist(title);
    if (!isActorContextCurrent(actor)) return null;
    await putMediaListSnapshot(actor.userId, "playlist", snapshot);
    useMediaStore.getState().setCurrentPlaylist(snapshot);
    void refreshMediaPlaylists();
    return snapshot;
  } catch (error) {
    captureDetachedClientIncident("media.playlist.create", error);
    return null;
  }
}

/** Record a local presentation fact: this user last played this playlist. */
export async function recordMediaPlaylistPlay(
  playlistId: string,
): Promise<void> {
  const actor = captureActorContext();
  const playedAt = new Date().toISOString();
  const store = useMediaStore.getState();
  const lastPlayed = { ...store.playlistLastPlayed, [playlistId]: playedAt };
  store.setPlaylistLastPlayed(lastPlayed);
  store.setPlaylists(sortPlaylistsByLastPlayed(store.playlists, lastPlayed));
  try {
    await putMediaPlaylistLastPlayed(actor.userId, playlistId, playedAt);
  } catch (error) {
    captureDetachedClientIncident("media.playlist.last-played", error);
  }
}

export async function deleteMediaPlaylist(playlistId: string): Promise<void> {
  try {
    await mediaDeletePlaylist(playlistId);
    useMediaStore.getState().setCurrentPlaylist(null);
    void refreshMediaPlaylists();
  } catch (error) {
    captureDetachedClientIncident("media.playlist.delete", error);
  }
}

export async function addTrackToPlaylist(
  playlistId: string,
  trackId: string,
): Promise<void> {
  const actor = captureActorContext();
  try {
    const snapshot = await mediaAddToPlaylist(playlistId, trackId);
    if (!isActorContextCurrent(actor)) return;
    await putMediaListSnapshot(actor.userId, "playlist", snapshot);
    const store = useMediaStore.getState();
    if (store.currentPlaylist?.list.id === playlistId) {
      store.setCurrentPlaylist(snapshot);
    }
    void refreshMediaPlaylists();
  } catch (error) {
    captureDetachedClientIncident("media.playlist.add", error);
  }
}

export async function removeTrackFromPlaylist(
  playlistId: string,
  trackId: string,
): Promise<void> {
  const actor = captureActorContext();
  try {
    const snapshot = await mediaRemoveFromPlaylist(playlistId, trackId);
    if (!isActorContextCurrent(actor)) return;
    await putMediaListSnapshot(actor.userId, "playlist", snapshot);
    const store = useMediaStore.getState();
    if (store.currentPlaylist?.list.id === playlistId) {
      store.setCurrentPlaylist(snapshot);
    }
    void refreshMediaPlaylists();
  } catch (error) {
    captureDetachedClientIncident("media.playlist.remove", error);
  }
}

export async function refreshMediaConfig(): Promise<void> {
  try {
    const config = await mediaFetchConfig();
    useMediaStore.getState().setConfig(config);
  } catch (error) {
    captureDetachedClientIncident("media.config.refresh", error);
  }
}

/** Patch cached presentation rows with server materialization progress. */
export function applyMediaMaterializationEvent(data: {
  track_id: string;
  audio_state: "absent" | "queued" | "downloading" | "ready" | "failed";
  audio_progress: number | null;
  cover_state: "absent" | "queued" | "downloading" | "ready" | "failed";
}): void {
  const store = useMediaStore.getState();
  const patch = (track: MediaTrack): MediaTrack =>
    track.id === data.track_id
      ? {
          ...track,
          materialization: {
            audio: {
              ...track.materialization.audio,
              state: data.audio_state,
            },
            cover: {
              ...track.materialization.cover,
              state: data.cover_state,
            },
          },
        }
      : track;
  store.setSearchResults(store.searchResults.map(patch));
  if (store.player.currentTrack) {
    store.patchPlayer({ currentTrack: patch(store.player.currentTrack) });
  }
  if (store.queue) {
    store.setQueue({
      ...store.queue,
      tracks: store.queue.tracks.map(patch),
    });
  }
  if (store.currentPlaylist) {
    store.setCurrentPlaylist({
      ...store.currentPlaylist,
      tracks: store.currentPlaylist.tracks.map(patch),
    });
  }
}

export async function updatePlaylistRetention(
  playlistId: string,
  days: number,
): Promise<void> {
  const actor = captureActorContext();
  try {
    const snapshot = await mediaUpdatePlaylistRetention(playlistId, days);
    if (!isActorContextCurrent(actor)) return;
    await putMediaListSnapshot(actor.userId, "playlist", snapshot);
    useMediaStore.getState().setCurrentPlaylist(snapshot);
    void refreshMediaPlaylists();
  } catch (error) {
    captureDetachedClientIncident("media.playlist.retention", error);
  }
}

/** Called on session changes; durable tracks are objective and may survive. */
export function resetMediaPresentation(): void {
  useMediaStore.getState().resetForActor();
}
