/**
 * Periodic maintenance: session cleanup, client TTL, idle-lock notifications,
 * and storage quota reconciliation.
 */
import type BetterSqlite3 from "better-sqlite3";
import { publishClient } from "@/server/runtime/eventBus";
import {
  getIdleLockEnabled,
  IDLE_LOCK_TIMEOUT_MINUTES,
} from "@/server/data/appState";
import {
  deleteExpiredSessions,
  listIdleLockedClientIds,
  listInactiveClientIds,
} from "@/server/data/maintenance";
import { createClientService } from "@/server/services/clientsService";
import { recordContainedServerIncident } from "./incidentService";
import { BUILD_ID } from "@/server/infra/env";
import type { Coordinator } from "@/server/runtime/coordinator";
import { reconcileStaleAiWorkspaces } from "@/server/services/ai/aiWorkspace";

/** Temporary client records with no recent activity are removed after this many days. */
const CLIENT_TTL_DAYS = 1;

/** Remove sessions older than 24h — shared by autoLogin and maintenance. */
function cleanupExpiredSessions(db: BetterSqlite3.Database): number {
  return deleteExpiredSessions(db);
}

/**
 * Delete temporary clients inactive for CLIENT_TTL_DAYS with no active session.
 * Preserves the 24h session cleanup in cleanupExpiredSessions.
 */
function cleanupInactiveClients(db: BetterSqlite3.Database): string[] {
  const clients = createClientService(db);
  const deleted: string[] = [];
  for (const id of listInactiveClientIds(db, CLIENT_TTL_DAYS)) {
    if (clients.delete(id)) {
      deleted.push(id);
    }
  }
  return deleted;
}

/** Notify clients that crossed the idle threshold (when idle lock is enabled). */
function notifyIdleLockedClients(db: BetterSqlite3.Database): number {
  if (!getIdleLockEnabled(db)) return 0;

  const notified = new Set<string>();
  for (const id of listIdleLockedClientIds(db, IDLE_LOCK_TIMEOUT_MINUTES)) {
    if (notified.has(id)) continue;
    notified.add(id);
    publishClient(id, { kind: "client.idle_locked", data: {} });
  }
  return notified.size;
}

const MAINTENANCE_INTERVAL_MS = 60_000;

async function runMaintenance(
  db: BetterSqlite3.Database,
  coordinator: Coordinator,
): Promise<void> {
  cleanupExpiredSessions(db);
  cleanupInactiveClients(db);
  notifyIdleLockedClients(db);
  coordinator.media.reconcileTransient();
  await coordinator.storage.reconcileStorage();
  await coordinator.articleUploads.reconcile();
  await coordinator.postImages.reconcile();
  await reconcileStaleAiWorkspaces(db, coordinator.storage.blobs);
}

export function startMaintenance(
  db: BetterSqlite3.Database,
  coordinator: Coordinator,
): () => void {
  const run = () =>
    void runMaintenance(db, coordinator).catch((error) => {
      recordContainedServerIncident(db, BUILD_ID, error, {
        component: "maintenance",
      });
    });
  run();
  const timer = setInterval(run, MAINTENANCE_INTERVAL_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}
