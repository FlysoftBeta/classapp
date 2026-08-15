export interface Fact<T> {
  readonly key: symbol;
  readonly valueType?: T;
}

export function fact<T>(description: string): Fact<T> {
  return { key: Symbol(description) };
}

/** Request-local, resettable lazy facts owned by a stateful Service. */
export class Facts {
  private readonly values = new Map<symbol, unknown>();

  has<T>(entry: Fact<T>): boolean {
    return this.values.has(entry.key);
  }

  getOrInit<T>(entry: Fact<T>, initialize: () => T): T {
    if (this.values.has(entry.key)) {
      return this.values.get(entry.key) as T;
    }
    const value = initialize();
    this.values.set(entry.key, value);
    return value;
  }

  set<T>(entry: Fact<T>, value: T): void {
    this.values.set(entry.key, value);
  }

  invalidate<T>(entry: Fact<T>): void {
    this.values.delete(entry.key);
  }

  clear(): void {
    this.values.clear();
  }
}
