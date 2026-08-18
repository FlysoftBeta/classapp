import { AsyncLocalStorage } from "node:async_hooks";
import type { Database } from "better-sqlite3";
import { UnitOfWork } from "@/server/runtime/unitOfWork";
import { Actor } from "@/server/runtime/actor";
import { AuthorityService } from "@/server/services/authorityService";
import { Composition } from "@/server/runtime/composition";
import type { BlobStore } from "@/server/storage/blobStore";
import type { StickyCommand, StickyHost } from "@/server/runtime/sticky";

export interface RequestIdentity {
  token: string | null;
  userId: string | null;
  clientId: string | null;
  ip: string;
  userAgent: string;
  mac: string | null;
  requestId?: string;
}

export interface ScopeEntry<T> {
  readonly key: symbol;
  readonly valueType?: T;
}

export function scopeEntry<T>(description: string): ScopeEntry<T> {
  return { key: Symbol(description) };
}

const authorityEntry = scopeEntry<AuthorityService>("AuthorityService");
const actorEntry = scopeEntry<Actor>("Actor");
const compositionEntry = scopeEntry<Composition>("Composition");

export interface ScopeResources {
  db: Database;
  blobs: BlobStore;
  sticky: StickyHost;
  commands: StickyCommand[];
}

/** One Action or short HTTP request. Lives on one Executor (or Coordinator HTTP) thread. */
export class Scope {
  private readonly entries = new Map<symbol, unknown>();
  readonly unitOfWork: UnitOfWork;

  constructor(
    readonly resources: ScopeResources,
    readonly identity: RequestIdentity,
  ) {
    this.unitOfWork = new UnitOfWork(resources.db);
  }

  get db() {
    return this.resources.db;
  }

  get blobs() {
    return this.resources.blobs;
  }

  get sticky() {
    return this.resources.sticky;
  }

  get commands(): StickyCommand[] {
    return this.resources.commands;
  }

  queueCommand(command: StickyCommand): void {
    this.resources.commands.push(command);
  }

  getOrInit<T>(entry: ScopeEntry<T>, initialize: () => T): T {
    if (this.entries.has(entry.key)) {
      return this.entries.get(entry.key) as T;
    }
    const value = initialize();
    this.entries.set(entry.key, value);
    return value;
  }

  authority(): AuthorityService {
    return this.getOrInit(
      authorityEntry,
      () => new AuthorityService(this.db, this.identity.userId),
    );
  }

  actor(): Actor {
    return this.getOrInit(
      actorEntry,
      () => new Actor(this.authority(), this.identity.clientId),
    );
  }

  facades(): Composition {
    return this.getOrInit(compositionEntry, () => new Composition(this));
  }
}

const scopeStorage = new AsyncLocalStorage<Scope>();

export function withScope<T>(
  scope: Scope,
  operation: () => Promise<T>,
): Promise<T> {
  return scopeStorage.run(scope, operation);
}

export function currentScope(): Scope {
  const scope = scopeStorage.getStore();
  if (!scope) throw new Error("Request Scope is unavailable");
  return scope;
}
