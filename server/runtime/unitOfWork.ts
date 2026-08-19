import type { Database } from "better-sqlite3";
import {
  deliverDeferredEvents,
  withDeferredEvents,
} from "@/server/runtime/eventBus";

/** Owns transaction nesting and defers observable side effects until commit. */
export class UnitOfWork {
  private depth = 0;
  private readonly committed: Array<() => void> = [];

  constructor(readonly db: Database) {}

  run<T>(operation: () => T): T {
    const outermost = this.depth === 0;
    const checkpoint = this.committed.length;
    this.depth += 1;
    let result: T;
    let deferred: Parameters<typeof deliverDeferredEvents>[0] = [];
    try {
      if (outermost) {
        result = withDeferredEvents(
          () => this.db.transaction(operation)(),
          (events) => {
            deferred = events;
          },
        );
      } else {
        result = this.db.transaction(operation)();
      }
    } catch (error) {
      this.depth -= 1;
      this.committed.length = checkpoint;
      throw error;
    }
    this.depth -= 1;
    if (outermost) {
      this.flushCommitted();
      deliverDeferredEvents(deferred);
    }
    return result;
  }

  afterCommit(effect: () => void): void {
    if (this.depth === 0) {
      effect();
      return;
    }
    this.committed.push(effect);
  }

  private flushCommitted(): void {
    const effects = this.committed.splice(0);
    let firstError: unknown = null;
    for (const effect of effects) {
      try {
        effect();
      } catch (error) {
        // One failed post-commit effect must not suppress the others.
        console.error("[UnitOfWork] post-commit effect failed", error);
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
  }
}
