import { create } from "zustand";
import type {
  MediaConfig,
  MediaListSnapshot,
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
  queue: MediaListSnapshot | null;
  playlists: MediaPlaylistSummary[];
  currentPlaylist: MediaListSnapshot | null;
  searchResults: MediaTrack[];
  searchLoading: boolean;
  searchError: string | null;
  config: MediaConfig | null;
  player: MediaPlayerState;
  queueDrawerOpen: boolean;
  playlistLastPlayed: Record<string, string>;

  setQueue(value: MediaListSnapshot | null): void;
  setPlaylists(value: MediaPlaylistSummary[]): void;
  setCurrentPlaylist(value: MediaListSnapshot | null): void;
  setSearchResults(value: MediaTrack[]): void;
  setSearchLoading(value: boolean): void;
  setSearchError(value: string | null): void;
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
