import { PublicError } from "@/server/services/incidentService";
import { withActionScope } from "./_base";
import type { ActionInput } from "@/shared/protocol/actions";

export async function mediaSearchAction(input: ActionInput<"mediaSearchAction">) {
  return withActionScope(async (scope) => {
    const query = input.query.trim();
    if (!query) throw new PublicError("请输入搜索词");
    return scope.facades().media().search(query, input.limit ?? 20);
  });
}

export async function mediaEnsureTrackAction(
  input: ActionInput<"mediaEnsureTrackAction">,
) {
  return withActionScope(async (scope) =>
    scope.facades().media().ensureTrack(input),
  );
}

export async function mediaFetchQueueAction() {
  return withActionScope(async (scope) => scope.facades().media().queue());
}

export async function mediaAddToQueueAction(
  input: ActionInput<"mediaAddToQueueAction">,
) {
  return withActionScope(async (scope) =>
    scope.facades().media().addToQueue(input.trackId),
  );
}

export async function mediaRemoveFromQueueAction(
  input: ActionInput<"mediaRemoveFromQueueAction">,
) {
  return withActionScope(async (scope) =>
    scope.facades().media().removeFromQueue(input.trackId),
  );
}

export async function mediaClearQueueAction() {
  return withActionScope(async (scope) => scope.facades().media().clearQueue());
}

export async function mediaPlayAction(
  input: ActionInput<"mediaPlayAction">,
) {
  return withActionScope(async (scope) =>
    scope.facades().media().play(input.trackId),
  );
}

export async function mediaListPlaylistsAction() {
  return withActionScope(async (scope) =>
    scope.facades().media().playlists(),
  );
}

export async function mediaFetchPlaylistAction(
  playlistId: ActionInput<"mediaFetchPlaylistAction">,
) {
  return withActionScope(async (scope) =>
    scope.facades().media().playlist(playlistId),
  );
}

export async function mediaCreatePlaylistAction(
  input: ActionInput<"mediaCreatePlaylistAction">,
) {
  return withActionScope(async (scope) =>
    scope.facades().media().createPlaylist(input.title),
  );
}

export async function mediaDeletePlaylistAction(
  playlistId: ActionInput<"mediaDeletePlaylistAction">,
) {
  return withActionScope(async (scope) => {
    scope.facades().media().deletePlaylist(playlistId);
    return { ok: true as const };
  });
}

export async function mediaAddToPlaylistAction(
  input: ActionInput<"mediaAddToPlaylistAction">,
) {
  return withActionScope(async (scope) =>
    scope
      .facades()
      .media()
      .addToPlaylist(input.playlistId, input.trackId),
  );
}

export async function mediaRemoveFromPlaylistAction(
  input: ActionInput<"mediaRemoveFromPlaylistAction">,
) {
  return withActionScope(async (scope) =>
    scope
      .facades()
      .media()
      .removeFromPlaylist(input.playlistId, input.trackId),
  );
}

export async function mediaUpdatePlaylistRetentionAction(
  input: ActionInput<"mediaUpdatePlaylistRetentionAction">,
) {
  return withActionScope(async (scope) =>
    scope
      .facades()
      .media()
      .updatePlaylistRetention(input.playlistId, input.days),
  );
}

export async function mediaFetchConfigAction() {
  return withActionScope(async (scope) => scope.facades().media().config());
}

export async function mediaAdminUpdateConfigAction(
  input: ActionInput<"mediaAdminUpdateConfigAction">,
) {
  return withActionScope(async (scope) =>
    scope.facades().media().adminUpdateConfig(input),
  );
}
