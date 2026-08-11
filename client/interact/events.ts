import type { PostStreamEvent, UserConfigChangedEvent } from "./types";
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
          // One rendering consumer cannot break the global data subscriber.
          reportDetachedClientFailure("local-event.listener", error);
        }
      }
    },
    subscribe(listener: Listener<T>): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const postEvents = createEventStream<PostStreamEvent>();
export const configEvents = createEventStream<UserConfigChangedEvent>();
export const announcementEvents = createEventStream<{ revision: number }>();
