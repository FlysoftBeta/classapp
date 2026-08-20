import {
  mediaAddToPlaylist,
  mediaAddToQueue,
  mediaClearQueue,
  mediaCreatePlaylist,
  mediaDeletePlaylist,
  mediaFetchConfig,
  mediaFetchPlaylist,
  mediaFetchQueue,
  mediaGrantPlaylistAccess,
  mediaLibrary,
  mediaListPlaylistBindings,
  mediaListPlaylists,
  mediaPlay,
  mediaRemoveFromPlaylist,
  mediaRemoveFromQueue,
  mediaRevokePlaylistAccess,
  mediaSearch,
  mediaSetTrackFavorite,
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
import {
  adoptMediaListSnapshot,
  rememberSignedTracks,
  trackCapability,
} from "./capabilities";
import { useMediaStore } from "./mediaStore";
import { captureDetachedClientIncident } from "./clientIncidents";
import type { AccessGrant, PrincipalRef } from "@/shared/access";
import type {
  MediaListView,
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

async function persistList(
  actorUserId: string,
  kind: "playlist" | "queue",
  snapshot: Parameters<typeof adoptMediaListSnapshot>[0],
): Promise<MediaListView> {
  const view = adoptMediaListSnapshot(snapshot);
  await putMediaListSnapshot(actorUserId, kind, view);
  return view;
}

export async function refreshMediaQueue(): Promise<void> {
  const actor = captureActorContext();
  try {
    const snapshot = await mediaFetchQueue();
    if (!isActorContextCurrent(actor)) return;
    const view = await persistList(actor.userId, "queue", snapshot);
    useMediaStore.getState().setQueue(view);
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

export async function refreshMediaLibrary(): Promise<void> {
  try {
    const library = await mediaLibrary();
    const recents = rememberSignedTracks(library.recents);
    const favorites = rememberSignedTracks(library.favorites);
    const store = useMediaStore.getState();
    store.setLibraryRecents(recents);
    store.setLibraryFavorites(favorites);
    store.setFavoriteTrackIds(new Set(favorites.map((track) => track.id)));
    const lastPlayed = store.playlistLastPlayed;
    store.setPlaylists(
      sortPlaylistsByLastPlayed(library.playlists, lastPlayed),
    );
  } catch (error) {
    captureDetachedClientIncident("media.library.refresh", error);
  }
}

export async function openMediaPlaylist(playlistId: string): Promise<void> {
  const actor = captureActorContext();
  try {
    const snapshot = await mediaFetchPlaylist(playlistId);
    if (!isActorContextCurrent(actor)) return;
    const view = await persistList(actor.userId, "playlist", snapshot);
    useMediaStore.getState().setCurrentPlaylist(view);
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
    const tracks = rememberSignedTracks(result.tracks);
    await putMediaTracks(tracks);
    useMediaStore.getState().setSearchResults(tracks);
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
    const snapshot = await mediaAddToQueue(trackId, trackCapability(trackId));
    if (!isActorContextCurrent(actor)) return;
    const view = await persistList(actor.userId, "queue", snapshot);
    useMediaStore.getState().setQueue(view);
  } catch (error) {
    captureDetachedClientIncident("media.queue.add", error);
  }
}

export async function removeTrackFromQueue(trackId: string): Promise<void> {
  const actor = captureActorContext();
  try {
    const snapshot = await mediaRemoveFromQueue(trackId);
    if (!isActorContextCurrent(actor)) return;
    const view = await persistList(actor.userId, "queue", snapshot);
    useMediaStore.getState().setQueue(view);
  } catch (error) {
    captureDetachedClientIncident("media.queue.remove", error);
  }
}

export async function clearMediaQueue(): Promise<void> {
  const actor = captureActorContext();
  try {
    const snapshot = await mediaClearQueue();
    if (!isActorContextCurrent(actor)) return;
    const view = await persistList(actor.userId, "queue", snapshot);
    useMediaStore.getState().setQueue(view);
  } catch (error) {
    captureDetachedClientIncident("media.queue.clear", error);
  }
}

export async function requestMediaPlay(trackId: string) {
  return mediaPlay(trackId, trackCapability(trackId));
}

export async function createMediaPlaylist(
  title: string,
): Promise<MediaListView | null> {
  const actor = captureActorContext();
  try {
    const snapshot = await mediaCreatePlaylist(title);
    if (!isActorContextCurrent(actor)) return null;
    const view = await persistList(actor.userId, "playlist", snapshot);
    useMediaStore.getState().setCurrentPlaylist(view);
    void refreshMediaPlaylists();
    void refreshMediaLibrary();
    return view;
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
    void refreshMediaLibrary();
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
    const snapshot = await mediaAddToPlaylist(
      playlistId,
      trackId,
      trackCapability(trackId),
    );
    if (!isActorContextCurrent(actor)) return;
    const view = await persistList(actor.userId, "playlist", snapshot);
    const store = useMediaStore.getState();
    if (store.currentPlaylist?.list.id === playlistId) {
      store.setCurrentPlaylist(view);
    }
    void refreshMediaPlaylists();
    void refreshMediaLibrary();
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
    const view = await persistList(actor.userId, "playlist", snapshot);
    const store = useMediaStore.getState();
    if (store.currentPlaylist?.list.id === playlistId) {
      store.setCurrentPlaylist(view);
    }
    void refreshMediaPlaylists();
    void refreshMediaLibrary();
  } catch (error) {
    captureDetachedClientIncident("media.playlist.remove", error);
  }
}

export async function grantPlaylistAccess(
  playlistId: string,
  principal: PrincipalRef,
  grant: AccessGrant,
): Promise<void> {
  const actor = captureActorContext();
  try {
    const snapshot = await mediaGrantPlaylistAccess({
      playlistId,
      principal,
      grant,
    });
    if (!isActorContextCurrent(actor)) return;
    const view = await persistList(actor.userId, "playlist", snapshot);
    useMediaStore.getState().setCurrentPlaylist(view);
    void refreshMediaLibrary();
  } catch (error) {
    captureDetachedClientIncident("media.playlist.grant", error);
  }
}

export async function revokePlaylistAccess(
  playlistId: string,
  principal: PrincipalRef,
): Promise<void> {
  const actor = captureActorContext();
  try {
    const snapshot = await mediaRevokePlaylistAccess({ playlistId, principal });
    if (!isActorContextCurrent(actor)) return;
    const view = await persistList(actor.userId, "playlist", snapshot);
    useMediaStore.getState().setCurrentPlaylist(view);
    void refreshMediaLibrary();
  } catch (error) {
    captureDetachedClientIncident("media.playlist.revoke", error);
  }
}

export async function listPlaylistBindings(playlistId: string) {
  return mediaListPlaylistBindings(playlistId);
}

export async function setTrackFavorite(
  trackId: string,
  favorited: boolean,
): Promise<void> {
  try {
    const result = await mediaSetTrackFavorite({
      trackId,
      favorited,
      updatedAt: Date.now(),
      capability: trackCapability(trackId),
    });
    const store = useMediaStore.getState();
    const next = new Set(store.favoriteTrackIds);
    if (result.value) next.add(trackId);
    else next.delete(trackId);
    store.setFavoriteTrackIds(next);
    void refreshMediaLibrary();
  } catch (error) {
    captureDetachedClientIncident("media.track.favorite", error);
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
  store.setLibraryRecents(store.libraryRecents.map(patch));
  store.setLibraryFavorites(store.libraryFavorites.map(patch));
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
    const view = await persistList(actor.userId, "playlist", snapshot);
    useMediaStore.getState().setCurrentPlaylist(view);
    void refreshMediaPlaylists();
  } catch (error) {
    captureDetachedClientIncident("media.playlist.retention", error);
  }
}

/** Called on session changes; durable tracks are objective and may survive. */
export function resetMediaPresentation(): void {
  useMediaStore.getState().resetForActor();
}
