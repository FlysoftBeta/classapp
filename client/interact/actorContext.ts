import {
  offlineRepository,
  type OfflineRepository,
} from "@/client/data/repository";
import { session } from "@/client/interact/remote/session";

/** Immutable user identity captured at an operation boundary. */
export class ActorContext {
  constructor(
    readonly userId: string,
    readonly authEpoch: number,
  ) {}
}

export function captureActorContext(): ActorContext {
  return new ActorContext(
    session.getUserId() ?? "anonymous",
    session.getEpoch(),
  );
}

export function repositoryForActor(context: ActorContext): OfflineRepository {
  return offlineRepository(context.userId);
}

export function isActorContextCurrent(context: ActorContext): boolean {
  return (
    context.userId === (session.getUserId() ?? "anonymous") &&
    context.authEpoch === session.getEpoch()
  );
}

/**
 * Compatibility facade for small one-shot operations. It captures the actor
 * before invoking a repository method; the repository never rereads session
 * state across awaits. Multi-step use cases should retain one ActorContext.
 */
export const currentActorRepository = new Proxy({} as OfflineRepository, {
  get(_target, property: keyof OfflineRepository) {
    const repository = repositoryForActor(captureActorContext());
    const value = repository[property];
    return typeof value === "function" ? value.bind(repository) : value;
  },
});
