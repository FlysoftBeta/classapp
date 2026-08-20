import { create } from "zustand";
import type {
  MediaConfig,
  MediaListView,
  MediaPlaylistSummary,
  MediaTrack,
} from "@/shared/media/types";

interface MediaPlayerState {
  currentTrackId: string | null;
  currentTrack: MediaTrack | null;
  playing: boolean;
  loading: boolean;
  userVolume: number;
  progressSeconds: number;
  durationSeconds: number;
}

interface MediaStore {
  queue: MediaListView | null;
  playlists: MediaPlaylistSummary[];
  currentPlaylist: MediaListView | null;
  searchResults: MediaTrack[];
  searchLoading: boolean;
  searchError: string | null;
  libraryRecents: MediaTrack[];
  libraryFavorites: MediaTrack[];
  favoriteTrackIds: Set<string>;
  config: MediaConfig | null;
  player: MediaPlayerState;
  queueDrawerOpen: boolean;
  playlistLastPlayed: Record<string, string>;

  setQueue(value: MediaListView | null): void;
  setPlaylists(value: MediaPlaylistSummary[]): void;
  setCurrentPlaylist(value: MediaListView | null): void;
  setSearchResults(value: MediaTrack[]): void;
  setSearchLoading(value: boolean): void;
  setSearchError(value: string | null): void;
  setLibraryRecents(value: MediaTrack[]): void;
  setLibraryFavorites(value: MediaTrack[]): void;
  setFavoriteTrackIds(value: Set<string>): void;
  setConfig(value: MediaConfig): void;
  patchPlayer(value: Partial<MediaPlayerState>): void;
  setQueueDrawerOpen(value: boolean): void;
  setPlaylistLastPlayed(value: Record<string, string>): void;
  resetForActor(): void;
}

export const useMediaStore = create<MediaStore>((set) => ({
  queue: null,
  playlists: [],
  currentPlaylist: null,
  searchResults: [],
  searchLoading: false,
  searchError: null,
  libraryRecents: [],
  libraryFavorites: [],
  favoriteTrackIds: new Set<string>(),
  config: null,
  queueDrawerOpen: false,
  playlistLastPlayed: {},
  player: {
    currentTrackId: null,
    currentTrack: null,
    playing: false,
    loading: false,
    userVolume: 0.8,
    progressSeconds: 0,
    durationSeconds: 0,
  },
  setQueue: (queue) => set({ queue }),
  setPlaylists: (playlists) => set({ playlists }),
  setCurrentPlaylist: (currentPlaylist) => set({ currentPlaylist }),
  setSearchResults: (searchResults) => set({ searchResults }),
  setSearchLoading: (searchLoading) => set({ searchLoading }),
  setSearchError: (searchError) => set({ searchError }),
  setLibraryRecents: (libraryRecents) => set({ libraryRecents }),
  setLibraryFavorites: (libraryFavorites) => set({ libraryFavorites }),
  setFavoriteTrackIds: (favoriteTrackIds) => set({ favoriteTrackIds }),
  setConfig: (config) => set({ config }),
  patchPlayer: (value) =>
    set((state) => ({ player: { ...state.player, ...value } })),
  setQueueDrawerOpen: (queueDrawerOpen) => set({ queueDrawerOpen }),
  setPlaylistLastPlayed: (playlistLastPlayed) => set({ playlistLastPlayed }),
  resetForActor: () =>
    set({
      queue: null,
      playlists: [],
      currentPlaylist: null,
      searchResults: [],
      searchError: null,
      libraryRecents: [],
      libraryFavorites: [],
      favoriteTrackIds: new Set<string>(),
      queueDrawerOpen: false,
      playlistLastPlayed: {},
      player: {
        currentTrackId: null,
        currentTrack: null,
        playing: false,
        loading: false,
        userVolume: 0.8,
        progressSeconds: 0,
        durationSeconds: 0,
      },
    }),
}));
