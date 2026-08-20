import { EMPTY_ACCESS_FLAGS } from "@/shared/access";
import type {
  MediaListView,
  MediaPlaylistSummary,
  MediaTrack,
} from "@/shared/media/types";
import { requestResult, runTransaction } from "./idb";
import { STORES } from "./schema";
import type { RetentionRow } from "./model";
import { extentFiles } from "./files";

export interface StoredMediaListRow {
  id: string;
  /** Local actor that cached this snapshot, not a server owner. */
  owner_user_id: string;
  kind: "playlist" | "queue";
  title: string;
  revision: number;
  retention_days: number;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  cover_track_id: string | null;
  last_played_at: string | null;
}

interface StoredMediaTrackRow extends MediaTrack {
  touched_at: number;
}

interface StoredMediaListItemRow {
  list_id: string;
  position: number;
  track_id: string;
  added_at: string;
}

function trackRow(track: MediaTrack): StoredMediaTrackRow {
  return { ...track, touched_at: Date.now() };
}

export async function putMediaTracks(tracks: MediaTrack[]): Promise<void> {
  if (tracks.length === 0) return;
  await runTransaction([STORES.MEDIA_TRACKS], "readwrite", (tx) => {
    const store = tx.objectStore(STORES.MEDIA_TRACKS);
    for (const track of tracks) store.put(trackRow(track));
  });
}

export async function getMediaTrack(id: string): Promise<MediaTrack | null> {
  return runTransaction([STORES.MEDIA_TRACKS], "readonly", async (tx) => {
    const row = (await requestResult(
      tx.objectStore(STORES.MEDIA_TRACKS).get(id),
    )) as StoredMediaTrackRow | undefined;
    return row ? (row as MediaTrack) : null;
  });
}

export async function putMediaListSnapshot(
  ownerUserId: string,
  kind: "playlist" | "queue",
  snapshot: MediaListView,
): Promise<void> {
  await runTransaction(
    [STORES.MEDIA_TRACKS, STORES.MEDIA_LISTS, STORES.MEDIA_LIST_ITEMS],
    "readwrite",
    async (tx) => {
      const tracks = tx.objectStore(STORES.MEDIA_TRACKS);
      for (const track of snapshot.tracks) tracks.put(trackRow(track));
      const lists = tx.objectStore(STORES.MEDIA_LISTS);
      const previous = (await requestResult(lists.get(snapshot.list.id))) as
        StoredMediaListRow | undefined;
      lists.put({
        id: snapshot.list.id,
        owner_user_id: ownerUserId,
        kind,
        title: snapshot.list.title,
        revision: snapshot.list.revision,
        retention_days: snapshot.list.retention_days,
        created_at: snapshot.list.created_at,
        updated_at: snapshot.list.updated_at,
        expires_at: null,
        cover_track_id: snapshot.list.cover_track_id,
        last_played_at: previous?.last_played_at ?? null,
      } satisfies StoredMediaListRow);
      const items = tx.objectStore(STORES.MEDIA_LIST_ITEMS);
      await deleteListItems(items, snapshot.list.id);
      for (const item of snapshot.items) {
        items.put({
          list_id: snapshot.list.id,
          position: item.position,
          track_id: item.track_id,
          added_at: item.added_at,
        } satisfies StoredMediaListItemRow);
      }
    },
  );
}

function deleteListItems(store: IDBObjectStore, listId: string): Promise<void> {
  const range = IDBKeyRange.bound(
    [listId, 0],
    [listId, Number.MAX_SAFE_INTEGER],
  );
  return new Promise((resolve, reject) => {
    const request = store.openCursor(range);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      cursor.delete();
      cursor.continue();
    };
  });
}

async function listItems(
  store: IDBObjectStore,
  listId: string,
): Promise<StoredMediaListItemRow[]> {
  const range = IDBKeyRange.bound(
    [listId, 0],
    [listId, Number.MAX_SAFE_INTEGER],
  );
  return new Promise((resolve, reject) => {
    const request = store.openCursor(range);
    const rows: StoredMediaListItemRow[] = [];
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(rows);
        return;
      }
      rows.push(cursor.value as StoredMediaListItemRow);
      cursor.continue();
    };
  });
}

export async function getMediaListSnapshot(
  ownerUserId: string,
  kind: "playlist" | "queue",
  listId: string,
): Promise<MediaListView | null> {
  return runTransaction(
    [STORES.MEDIA_TRACKS, STORES.MEDIA_LISTS, STORES.MEDIA_LIST_ITEMS],
    "readonly",
    async (tx) => {
      const list = (await requestResult(
        tx.objectStore(STORES.MEDIA_LISTS).get(listId),
      )) as StoredMediaListRow | undefined;
      if (!list || list.owner_user_id !== ownerUserId || list.kind !== kind) {
        return null;
      }
      const items = await listItems(
        tx.objectStore(STORES.MEDIA_LIST_ITEMS),
        listId,
      );
      const tracks: MediaTrack[] = [];
      const trackStore = tx.objectStore(STORES.MEDIA_TRACKS);
      for (const item of items) {
        const row = (await requestResult(trackStore.get(item.track_id))) as
          StoredMediaTrackRow | undefined;
        if (row) tracks.push(row as MediaTrack);
      }
      return {
        list: {
          id: list.id,
          title: list.title,
          revision: list.revision,
          retention_days: list.retention_days,
          created_at: list.created_at,
          updated_at: list.updated_at,
          track_count: items.length,
          cover_track_id: list.cover_track_id ?? null,
          origin_group_id: null,
          access: EMPTY_ACCESS_FLAGS,
        },
        items,
        tracks,
      };
    },
  );
}

export async function listMediaPlaylists(
  ownerUserId: string,
): Promise<MediaPlaylistSummary[]> {
  return runTransaction(
    [STORES.MEDIA_LISTS, STORES.MEDIA_LIST_ITEMS],
    "readonly",
    async (tx) => {
      const rows = (await requestResult(
        tx
          .objectStore(STORES.MEDIA_LISTS)
          .index("by-owner-kind")
          .getAll(IDBKeyRange.only([ownerUserId, "playlist"])),
      )) as StoredMediaListRow[];
      const result: MediaPlaylistSummary[] = [];
      const lastPlayed: Record<string, string> = {};
      for (const row of rows) {
        if (row.last_played_at) lastPlayed[row.id] = row.last_played_at;
        const items = await listItems(
          tx.objectStore(STORES.MEDIA_LIST_ITEMS),
          row.id,
        );
        result.push({
          id: row.id,
          title: row.title,
          revision: row.revision,
          retention_days: row.retention_days,
          created_at: row.created_at,
          updated_at: row.updated_at,
          track_count: items.length,
          cover_track_id: row.cover_track_id ?? null,
          origin_group_id: null,
          access: EMPTY_ACCESS_FLAGS,
        });
      }
      return result.sort((left, right) =>
        (lastPlayed[right.id] ?? right.updated_at).localeCompare(
          lastPlayed[left.id] ?? left.updated_at,
        ),
      );
    },
  );
}

export async function listMediaPlaylistLastPlayed(
  ownerUserId: string,
): Promise<Record<string, string>> {
  return runTransaction([STORES.MEDIA_LISTS], "readonly", async (tx) => {
    const rows = (await requestResult(
      tx
        .objectStore(STORES.MEDIA_LISTS)
        .index("by-owner-kind")
        .getAll(IDBKeyRange.only([ownerUserId, "playlist"])),
    )) as StoredMediaListRow[];
    const result: Record<string, string> = {};
    for (const row of rows) {
      if (row.last_played_at) result[row.id] = row.last_played_at;
    }
    return result;
  });
}

export async function putMediaPlaylistLastPlayed(
  ownerUserId: string,
  playlistId: string,
  lastPlayedAt: string,
): Promise<void> {
  await runTransaction([STORES.MEDIA_LISTS], "readwrite", async (tx) => {
    const store = tx.objectStore(STORES.MEDIA_LISTS);
    const row = (await requestResult(store.get(playlistId))) as
      StoredMediaListRow | undefined;
    if (!row || row.owner_user_id !== ownerUserId || row.kind !== "playlist") {
      return;
    }
    store.put({ ...row, last_played_at: lastPlayedAt });
  });
}

export async function clearActorMediaLists(ownerUserId: string): Promise<void> {
  await runTransaction(
    [STORES.MEDIA_LISTS, STORES.MEDIA_LIST_ITEMS],
    "readwrite",
    async (tx) => {
      const rows = (await requestResult(
        tx
          .objectStore(STORES.MEDIA_LISTS)
          .index("by-owner-kind")
          .getAll(
            IDBKeyRange.bound(
              [ownerUserId, "playlist"],
              [ownerUserId, "queue"],
            ),
          ),
      )) as StoredMediaListRow[];
      const items = tx.objectStore(STORES.MEDIA_LIST_ITEMS);
      for (const row of rows) {
        tx.objectStore(STORES.MEDIA_LISTS).delete(row.id);
        await deleteListItems(items, row.id);
      }
    },
  );
}

export async function claimMediaTrack(
  claimant: string,
  trackId: string,
  protectedUntil: number,
  materialized = false,
): Promise<void> {
  await runTransaction([STORES.SAVE], "readwrite", (tx) => {
    const store = tx.objectStore(STORES.SAVE);
    store.put({
      claimant,
      kind: "media",
      object_id: trackId,
      mode: "retained",
      keep_after_ms: null,
      protected_until: protectedUntil,
      materialized,
      bytes: 0,
      last_touched_at: Date.now(),
      missing_reason: materialized ? null : "never-downloaded",
    } satisfies RetentionRow);
  });
}

export async function protectedMediaTracks(
  claimant: string,
): Promise<Set<string>> {
  return runTransaction([STORES.SAVE], "readonly", async (tx) => {
    const rows = await new Promise<RetentionRow[]>((resolve, reject) => {
      const request = tx
        .objectStore(STORES.SAVE)
        .index("by-resource")
        .openCursor(IDBKeyRange.bound(["media", ""], ["media", "\uffff"]));
      const found: RetentionRow[] = [];
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(found);
          return;
        }
        found.push(cursor.value as RetentionRow);
        cursor.continue();
      };
    });
    const now = Date.now();
    return new Set(
      rows
        .filter(
          (row) =>
            row.claimant === claimant &&
            row.mode === "retained" &&
            row.protected_until > now,
        )
        .map((row) => row.object_id),
    );
  });
}

/**
 * Quota eviction for media extents. Protects tracks covered by any unexpired
 * media claim; older claimed tracks are not automatically protected here.
 */
export async function handleMediaQuotaPressure(
  targetBytes: number,
): Promise<number> {
  const heads = await extentFiles.list("media:");
  const now = Date.now();
  const protectedIds = await runTransaction(
    [STORES.SAVE],
    "readonly",
    async (tx) => {
      const rows = (await requestResult(
        tx
          .objectStore(STORES.SAVE)
          .index("by-resource")
          .getAll(IDBKeyRange.bound(["media", ""], ["media", "\uffff"])),
      )) as RetentionRow[];
      return new Set(
        rows
          .filter((row) => row.mode === "retained" && row.protected_until > now)
          .map((row) => row.object_id),
      );
    },
  );
  heads.sort((left, right) => left.created_at - right.created_at);
  let freed = 0;
  for (const head of heads) {
    if (freed >= targetBytes) break;
    const trackId = head.id.slice("media:".length).split(":")[0];
    if (protectedIds.has(trackId)) continue;
    freed += await extentFiles.delete(head.id);
  }
  return freed;
}
