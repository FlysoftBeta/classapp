import type { ActionArgs } from "@/shared/protocol/actions";
import type { ActionResult } from "@/shared/protocol/result";
import { observeActionResult } from "./runtime";
import { client } from "@/client/interact/remote/client";

const {
  mediaSearchAction,
  mediaEnsureTrackAction,
  mediaFetchQueueAction,
  mediaAddToQueueAction,
  mediaRemoveFromQueueAction,
  mediaClearQueueAction,
  mediaPlayAction,
  mediaListPlaylistsAction,
  mediaFetchPlaylistAction,
  mediaCreatePlaylistAction,
  mediaDeletePlaylistAction,
  mediaAddToPlaylistAction,
  mediaRemoveFromPlaylistAction,
  mediaUpdatePlaylistRetentionAction,
  mediaGrantPlaylistAccessAction,
  mediaRevokePlaylistAccessAction,
  mediaListPlaylistBindingsAction,
  mediaLibraryAction,
  mediaSetTrackFavoriteAction,
  mediaFetchConfigAction,
  mediaAdminUpdateConfigAction,
} = client.actions;

async function requireData<T>(result: ActionResult<T>): Promise<T> {
  observeActionResult(result);
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

export async function mediaSearch(query: string, limit = 20) {
  const result = await mediaSearchAction({ query, limit });
  return requireData(result);
}

export async function mediaEnsureTrack(
  input: ActionArgs<"mediaEnsureTrackAction">[0],
) {
  const result = await mediaEnsureTrackAction(input);
  return requireData(result);
}

export async function mediaFetchQueue() {
  return requireData(await mediaFetchQueueAction());
}

export async function mediaAddToQueue(trackId: string, capability?: string) {
  return requireData(await mediaAddToQueueAction({ trackId, capability }));
}

export async function mediaRemoveFromQueue(trackId: string) {
  return requireData(await mediaRemoveFromQueueAction({ trackId }));
}

export async function mediaClearQueue() {
  return requireData(await mediaClearQueueAction());
}

export async function mediaPlay(trackId: string, capability?: string) {
  return requireData(await mediaPlayAction({ trackId, capability }));
}

export async function mediaListPlaylists() {
  return requireData(await mediaListPlaylistsAction());
}

export async function mediaFetchPlaylist(playlistId: string) {
  return requireData(await mediaFetchPlaylistAction(playlistId));
}

export async function mediaCreatePlaylist(title: string) {
  return requireData(await mediaCreatePlaylistAction({ title }));
}

export async function mediaDeletePlaylist(playlistId: string) {
  return requireData(await mediaDeletePlaylistAction(playlistId));
}

export async function mediaAddToPlaylist(
  playlistId: string,
  trackId: string,
  capability?: string,
) {
  return requireData(
    await mediaAddToPlaylistAction({ playlistId, trackId, capability }),
  );
}

export async function mediaRemoveFromPlaylist(
  playlistId: string,
  trackId: string,
) {
  return requireData(await mediaRemoveFromPlaylistAction({ playlistId, trackId }));
}

export async function mediaUpdatePlaylistRetention(
  playlistId: string,
  days: number,
) {
  return requireData(
    await mediaUpdatePlaylistRetentionAction({ playlistId, days }),
  );
}

export async function mediaGrantPlaylistAccess(
  input: ActionArgs<"mediaGrantPlaylistAccessAction">[0],
) {
  return requireData(await mediaGrantPlaylistAccessAction(input));
}

export async function mediaRevokePlaylistAccess(
  input: ActionArgs<"mediaRevokePlaylistAccessAction">[0],
) {
  return requireData(await mediaRevokePlaylistAccessAction(input));
}

export async function mediaListPlaylistBindings(playlistId: string) {
  return requireData(
    await mediaListPlaylistBindingsAction({ playlistId }),
  );
}

export async function mediaLibrary() {
  return requireData(await mediaLibraryAction());
}

export async function mediaSetTrackFavorite(
  input: ActionArgs<"mediaSetTrackFavoriteAction">[0],
) {
  return requireData(await mediaSetTrackFavoriteAction(input));
}

export async function mediaFetchConfig() {
  return requireData(await mediaFetchConfigAction());
}

export async function mediaAdminUpdateConfig(
  input: ActionArgs<"mediaAdminUpdateConfigAction">[0],
) {
  return requireData(await mediaAdminUpdateConfigAction(input));
}
