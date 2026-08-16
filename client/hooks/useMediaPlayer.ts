import { useCallback, useEffect, useRef } from "react";
import type { MediaTrack } from "@/shared/media/types";
import {
  recordMediaPlaylistPlay,
  requestMediaPlay,
} from "@/client/interact/media";
import { useMediaStore } from "@/client/interact/mediaStore";
import { lbAssetUrl } from "@/client/lib/loadBalancer";
import { claimMediaTrack } from "@/client/data/media";
import { extentFiles } from "@/client/data/files";
import { useApplicationStore } from "@/client/interact/appStore";
import { captureDetachedClientIncident } from "@/client/interact/clientIncidents";

/**
 * Chrome 70-compatible WebAudio pipeline:
 * <audio> -> MediaElementAudioSourceNode -> GainNode -> destination.
 * The server volume cap is policy, not DRM: effective = min(user, server cap).
 */
function mediaFileId(trackId: string): string {
  return `media:${trackId}:audio`;
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export interface MediaPlayContext {
  playlistId?: string;
}

export function useMediaPlayer() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const lastProgressAtRef = useRef(0);
  const queue = useMediaStore((state) => state.queue);
  const playlists = useMediaStore((state) => state.playlists);
  const config = useMediaStore((state) => state.config);
  const currentTrackId = useMediaStore((state) => state.player.currentTrackId);
  const userVolume = useMediaStore((state) => state.player.userVolume);
  const patchPlayer = useMediaStore((state) => state.patchPlayer);

  const ensureGraph = useCallback(() => {
    if (!audioRef.current) {
      audioRef.current = new Audio();
      audioRef.current.preload = "auto";
    }
    const audio = audioRef.current;
    if (!contextRef.current) {
      const AudioContextClass =
        window.AudioContext ??
        (window as Window & { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!AudioContextClass) return;
      contextRef.current = new AudioContextClass();
      sourceRef.current = contextRef.current.createMediaElementSource(audio);
      gainRef.current = contextRef.current.createGain();
      sourceRef.current.connect(gainRef.current);
      gainRef.current.connect(contextRef.current.destination);
    }
    void contextRef.current?.resume();
    const cap = config?.max_volume ?? 1;
    if (gainRef.current) {
      gainRef.current.gain.value = Math.min(userVolume, cap);
    }
  }, [config?.max_volume, userVolume]);

  useEffect(() => {
    ensureGraph();
    const audio = audioRef.current;
    if (!audio) return;
    const ended = () => patchPlayer({ playing: false });
    const error = () => patchPlayer({ playing: false, loading: false });
    const syncProgress = () => {
      const now = Date.now();
      if (now - lastProgressAtRef.current < 250) return;
      lastProgressAtRef.current = now;
      const duration =
        Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.duration
          : 0;
      patchPlayer({
        progressSeconds: audio.currentTime,
        ...(duration > 0 ? { durationSeconds: duration } : {}),
      });
    };
    audio.addEventListener("ended", ended);
    audio.addEventListener("error", error);
    audio.addEventListener("timeupdate", syncProgress);
    audio.addEventListener("durationchange", syncProgress);
    audio.addEventListener("loadedmetadata", syncProgress);
    return () => {
      audio.removeEventListener("ended", ended);
      audio.removeEventListener("error", error);
      audio.removeEventListener("timeupdate", syncProgress);
      audio.removeEventListener("durationchange", syncProgress);
      audio.removeEventListener("loadedmetadata", syncProgress);
    };
  }, [ensureGraph, patchPlayer]);

  const objectUrl = useCallback((buffer: ArrayBuffer, mime: string | null) => {
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    const url = URL.createObjectURL(
      new Blob([buffer], { type: mime ?? "audio/webm" }),
    );
    objectUrlRef.current = url;
    return url;
  }, []);

  const playTrack = useCallback(
    async (track: MediaTrack, context?: MediaPlayContext) => {
      const player = useMediaStore.getState().player;
      if (player.currentTrackId === track.id && player.loading) return;
      const playlistId = context?.playlistId ?? null;
      const playlist =
        playlistId === null
          ? null
          : (playlists.find((value) => value.id === playlistId) ?? null);
      patchPlayer({
        currentTrackId: track.id,
        currentTrack: track,
        loading: true,
        progressSeconds: 0,
        durationSeconds: track.duration_ms > 0 ? track.duration_ms / 1000 : 0,
      });
      lastProgressAtRef.current = 0;
      const recordPlay = () => {
        if (playlistId) void recordMediaPlaylistPlay(playlistId);
      };
      const logicalId = mediaFileId(track.id);
      const expectedBytes = track.materialization.audio.bytes;
      const expectedSha = track.materialization.audio.sha256;
      let cached: ArrayBuffer | null = null;
      if (expectedBytes > 0) {
        cached = await extentFiles.readAll(logicalId).catch(() => null);
        if (cached && cached.byteLength !== expectedBytes) cached = null;
      }
      try {
        const grant = await requestMediaPlay(track.id);
        const audio = audioRef.current;
        if (!audio) return;
        let sourceUrl: string | null = null;

        if (cached) {
          sourceUrl = objectUrl(cached, track.materialization.audio.mime);
        } else if (expectedBytes > 0 && expectedSha) {
          const response = await fetch(lbAssetUrl(grant.url));
          if (!response.ok)
            throw new Error(`音频请求失败：HTTP ${response.status}`);
          const buffer = await response.arrayBuffer();
          if (
            buffer.byteLength === expectedBytes &&
            (await sha256Hex(buffer)) === expectedSha
          ) {
            await extentFiles.replace(
              logicalId,
              expectedBytes,
              buffer,
              expectedSha,
            );
            cached = buffer;
          }
          sourceUrl = objectUrl(buffer, track.materialization.audio.mime);
        } else {
          // Metadata-only track: stream the one-time relay URL directly.
          sourceUrl = lbAssetUrl(grant.url);
        }
        ensureGraph();
        audio.src = sourceUrl;
        await audio.play();
        const duration =
          Number.isFinite(audio.duration) && audio.duration > 0
            ? audio.duration
            : track.duration_ms > 0
              ? track.duration_ms / 1000
              : 0;
        patchPlayer({
          playing: true,
          loading: false,
          progressSeconds: audio.currentTime,
          durationSeconds: duration,
        });
        recordPlay();
        const userId = useApplicationStore.getState().user?.id;
        if (userId) {
          const retentionDays = playlist?.retention_days ?? 7;
          void claimMediaTrack(
            userId,
            track.id,
            Date.now() + retentionDays * 24 * 60 * 60_000,
            cached !== null,
          );
        }
      } catch (error) {
        // Offline fallback: a verified local extent can play without a grant.
        if (!cached) {
          patchPlayer({ playing: false, loading: false });
          captureDetachedClientIncident("media.play", error);
          return;
        }
        try {
          ensureGraph();
          const audio = audioRef.current;
          if (!audio) return;
          audio.src = objectUrl(cached, track.materialization.audio.mime);
          await audio.play();
          const duration =
            Number.isFinite(audio.duration) && audio.duration > 0
              ? audio.duration
              : track.duration_ms > 0
                ? track.duration_ms / 1000
                : 0;
          patchPlayer({
            playing: true,
            loading: false,
            progressSeconds: audio.currentTime,
            durationSeconds: duration,
          });
          recordPlay();
        } catch (cachedError) {
          patchPlayer({ playing: false, loading: false });
          captureDetachedClientIncident("media.play-cached", cachedError);
        }
      }
    },
    [ensureGraph, objectUrl, patchPlayer, playlists],
  );

  const toggle = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      ensureGraph();
      try {
        await audio.play();
        patchPlayer({ playing: true });
      } catch {
        patchPlayer({ playing: false });
      }
    } else {
      audio.pause();
      patchPlayer({ playing: false });
    }
  }, [ensureGraph, patchPlayer]);

  const setVolume = useCallback(
    (value: number) => {
      patchPlayer({ userVolume: value });
      const cap = config?.max_volume ?? 1;
      if (gainRef.current) {
        gainRef.current.gain.value = Math.min(value, cap);
      }
    },
    [config?.max_volume, patchPlayer],
  );

  const seek = useCallback(
    (value: number) => {
      const audio = audioRef.current;
      if (!audio) return;
      const duration =
        Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.duration
          : 0;
      if (duration <= 0) return;
      const target = Math.min(Math.max(value, 0), duration);
      audio.currentTime = target;
      patchPlayer({ progressSeconds: target });
    },
    [patchPlayer],
  );

  const stop = useCallback(() => {
    const audio = audioRef.current;
    audio?.pause();
    audio?.removeAttribute("src");
    audio?.load();
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    patchPlayer({
      playing: false,
      loading: false,
      currentTrackId: null,
      currentTrack: null,
      progressSeconds: 0,
      durationSeconds: 0,
    });
  }, [patchPlayer]);

  const currentTrack =
    queue?.tracks.find((track) => track.id === currentTrackId) ?? null;

  const next = useCallback(() => {
    if (!queue || !currentTrack) return;
    const index = queue.items.findIndex(
      (item) => item.track_id === currentTrack.id,
    );
    const item = queue.items[index + 1];
    const track = item
      ? queue.tracks.find((value) => value.id === item.track_id)
      : null;
    if (track) void playTrack(track);
  }, [currentTrack, playTrack, queue]);

  const previous = useCallback(() => {
    if (!queue || !currentTrack) return;
    const index = queue.items.findIndex(
      (item) => item.track_id === currentTrack.id,
    );
    const item = queue.items[Math.max(0, index - 1)];
    const track = item
      ? queue.tracks.find((value) => value.id === item.track_id)
      : null;
    if (track) void playTrack(track);
  }, [currentTrack, playTrack, queue]);

  return { playTrack, toggle, stop, next, previous, setVolume, seek };
}

export type MediaPlayerApi = ReturnType<typeof useMediaPlayer>;
