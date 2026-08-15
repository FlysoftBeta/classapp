import { patchClientMe } from "@/client/api/auth";
import { sessionRepository } from "@/client/data/repository";
import { session } from "@/client/interact/remote/session";

export type ClientLockFlushResult =
  { accessRequired: false } | { accessRequired: true; clientId: string };

let inFlight: Promise<ClientLockFlushResult> | null = null;

/** Flush the active actor's lock proposal and acknowledge only that operation. */
export async function flushPendingClientLock(): Promise<ClientLockFlushResult> {
  if (inFlight) return inFlight;
  const run = (async (): Promise<ClientLockFlushResult> => {
    for (;;) {
      const pending = await sessionRepository.pendingKonamiLock();
      if (!pending || session.getUserId() !== pending.meId) {
        return { accessRequired: false } as const;
      }
      const result = await patchClientMe(pending.value);
      if (!result.ok) return { accessRequired: false } as const;
      if (!result.data.ok) {
        return "access_required" in result.data
          ? {
              accessRequired: true,
              clientId: result.data.client_id,
            }
          : { accessRequired: false };
      }
      await sessionRepository.acknowledgeKonamiLock(
        pending.meId,
        pending.operationId,
        result.data.konami_locked,
      );
      // A newer opposite proposal may have been written while this Action was
      // in flight. Continue until the active actor has no pending lock intent.
    }
  })().finally(() => {
    if (inFlight === run) inFlight = null;
  });
  inFlight = run;
  return run;
}
