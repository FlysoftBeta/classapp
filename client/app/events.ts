import type {
  PostStreamEvent,
  UserConfigChangedEvent,
} from "@/client/app/appReducer";

type Listener<T> = (event: T) => void;

function createEventStream<T>() {
  const listeners = new Set<Listener<T>>();
  return {
    emit(event: T): void {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          // Isolate consumers from one another.
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
