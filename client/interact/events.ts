import type { PostStreamEvent, UserConfigChangedEvent } from "./types";

type Listener<T> = (event: T) => void;

function createEventStream<T>() {
  const listeners = new Set<Listener<T>>();
  return {
    emit(event: T): void {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          // One rendering consumer cannot break the global data subscriber.
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
