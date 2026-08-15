import type { Database } from "better-sqlite3";

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
    try {
      result = this.db.transaction(operation)();
    } catch (error) {
      this.depth -= 1;
      this.committed.length = checkpoint;
      throw error;
    }
    this.depth -= 1;
    if (outermost) this.flushCommitted();
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
    for (const effect of effects) effect();
  }
}
