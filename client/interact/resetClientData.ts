import { runtimeDatabase } from "@/client/data/idb";
import { nukeApplicationDatabase } from "@/client/data/migration";

/** Clear this browser's application data and restart from a clean database. */
export async function resetClientData(): Promise<void> {
  runtimeDatabase.closeNow();
  await nukeApplicationDatabase();
  window.location.reload();
}
