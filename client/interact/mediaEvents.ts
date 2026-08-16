import type { MediaConfig } from "@/shared/media/types";
import type { EventData } from "@/shared/protocol/events";
import { reportDetachedClientFailure } from "./incidentContext";

type Listener<T> = (event: T) => void;

function createEventStream<T>() {
  const listeners = new Set<Listener<T>>();
  return {
    emit(event: T): void {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (error) {
          reportDetachedClientFailure("local-event.media", error);
        }
      }
    },
    subscribe(listener: Listener<T>): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const mediaTrackEvents = createEventStream<{ track_id: string }>();
export const mediaPlaylistEvents = createEventStream<{
  playlist_id: string;
  revision: number;
}>();
export const mediaQueueEvents = createEventStream<{ revision: number }>();
export const mediaConfigEvents = createEventStream<MediaConfig>();
export const mediaMaterializationEvents =
  createEventStream<EventData<"media.materialization.changed">>();
