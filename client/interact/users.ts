import type { UserMetadata } from "@/shared/types/api";
import { currentActorRepository } from "@/client/interact/actorContext";

/** Absorb a wire side bundle through the single normalized user-cache path. */
export async function cacheUserMetadata(
  users: readonly UserMetadata[],
): Promise<void> {
  await currentActorRepository.saveUserMetadata([...users]);
}

export function userMetadataById(
  users: readonly UserMetadata[],
): ReadonlyMap<string, UserMetadata> {
  return new Map(users.map((user) => [user.id, user]));
}
