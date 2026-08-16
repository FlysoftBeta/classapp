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

export async function mediaAddToQueue(trackId: string) {
  return requireData(await mediaAddToQueueAction({ trackId }));
}

export async function mediaRemoveFromQueue(trackId: string) {
  return requireData(await mediaRemoveFromQueueAction({ trackId }));
}

export async function mediaClearQueue() {
  return requireData(await mediaClearQueueAction());
}

export async function mediaPlay(trackId: string) {
  return requireData(await mediaPlayAction({ trackId }));
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

export async function mediaAddToPlaylist(playlistId: string, trackId: string) {
  return requireData(await mediaAddToPlaylistAction({ playlistId, trackId }));
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

export async function mediaFetchConfig() {
  return requireData(await mediaFetchConfigAction());
}

export async function mediaAdminUpdateConfig(
  input: ActionArgs<"mediaAdminUpdateConfigAction">[0],
) {
  return requireData(await mediaAdminUpdateConfigAction(input));
}
