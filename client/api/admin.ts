import type { ActionArgs, ActionData } from "@/shared/protocol/actions";
import { observeActionResult, apiFetch, authHeaders } from "./runtime";
import { client } from "@/client/interact/remote/client";

const {
  adminConfirmUpdateAction,
  adminCreateBackupAction,
  adminCreateGroupAction,
  adminCreateUserAction,
  adminDeleteBackupAction,
  adminDeleteGhostUserAction,
  adminFetchBackupsAction,
  adminFetchTeachDocumentsAction,
  adminFetchClientsAction,
  adminFetchConfigAction,
  adminFetchGhostUsersAction,
  adminFetchGroupsAction,
  adminFetchHttpsStatusAction,
  adminFetchUpdateStatusAction,
  adminFetchUsersAction,
  adminRollbackAction,
  adminRunToolAction,
  adminCleanupTeachDocumentsAction,
  adminUpdateConfigAction,
  adminMutateUsersAction,
  adminMutateGroupsAction,
  adminMutateClientsAction,
  adminWhitelistCurrentClientAction,
  adminFetchIncidentGroupsAction,
  adminFetchIncidentDetailsAction,
  adminTestIncidentAction,
  adminFetchAiCreditsAction,
  adminFetchAiBillingAction,
  adminUpdateAiBillingPolicyAction,
  adminAssignAiCreditsAction,
  adminFetchAuditLogAction,
} = client.actions;

export type AdminToolData = {
  message?: string;
  error?: string;
};

export type AdminAuditEntry =
  ActionData<"adminFetchAuditLogAction">["entries"][number];

export async function adminFetchAuditLog(offset = 0) {
  const result = await adminFetchAuditLogAction({ offset });
  observeActionResult(result);
  if (!result.ok) throw new Error(result.error.message);
  return result.data.entries;
}

// ── Users ───────────────────────────────────────────────────────────────────

export async function adminFetchUsers(query: string, offset = 0) {
  const result = await adminFetchUsersAction({ q: query, offset });
  observeActionResult(result);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.data;
}

export async function adminCreateUser(
  body: ActionArgs<"adminCreateUserAction">[0],
) {
  const result = await adminCreateUserAction(body);
  const res = observeActionResult(result);
  return {
    res,
    data: result.ok ? result.data : { error: result.error.message },
  };
}

export async function adminMutateUsers(
  changes: ActionArgs<"adminMutateUsersAction">[0]["changes"],
) {
  const result = await adminMutateUsersAction({ changes });
  observeActionResult(result);
  if (!result.ok) throw new Error(result.error.message);
}

export async function adminSearchUsers(query: string) {
  const result = await adminFetchUsersAction({ q: query });
  observeActionResult(result);
  return result.ok ? result.data : null;
}

export async function adminFetchAiCredits(userId: string) {
  const result = await adminFetchAiCreditsAction({ userId });
  observeActionResult(result);
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

export async function adminFetchAiBilling() {
  const result = await adminFetchAiBillingAction();
  observeActionResult(result);
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

export async function adminUpdateAiBillingPolicy(
  input: ActionArgs<"adminUpdateAiBillingPolicyAction">[0],
) {
  const result = await adminUpdateAiBillingPolicyAction(input);
  observeActionResult(result);
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

export async function adminAssignAiCredits(
  input: Omit<ActionArgs<"adminAssignAiCreditsAction">[0], "targets"> & {
    userIds: string[];
  },
) {
  const createIdempotencyKey = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
  };
  const { userIds, ...assignment } = input;
  const result = await adminAssignAiCreditsAction({
    ...assignment,
    targets: userIds.map((userId) => ({
      userId,
      idempotencyKey: createIdempotencyKey(),
    })),
  });
  observeActionResult(result);
  if (!result.ok) throw new Error(result.error.message);
}

// ── Ghost users ─────────────────────────────────────────────────────────────

export type AdminGhostUserRecord =
  ActionData<"adminFetchGhostUsersAction">["ghosts"][number];

export async function adminFetchGhostUsers() {
  const result = await adminFetchGhostUsersAction();
  observeActionResult(result);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.data;
}

export async function adminDeleteGhostUser(id: string) {
  return observeActionResult(await adminDeleteGhostUserAction(id));
}

// ── Groups ────────────────────────────────────────────────────────────────────

export type AdminGroupRecord =
  ActionData<"adminFetchGroupsAction">["groups"][number];

export async function adminFetchGroups(offset = 0) {
  const result = await adminFetchGroupsAction({ offset });
  observeActionResult(result);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.data;
}

export async function adminCreateGroup(
  body: ActionArgs<"adminCreateGroupAction">[0],
) {
  const result = await adminCreateGroupAction(body);
  const res = observeActionResult(result);
  return {
    res,
    data: result.ok ? result.data : { error: result.error.message },
  };
}

export async function adminMutateGroups(
  changes: ActionArgs<"adminMutateGroupsAction">[0]["changes"],
) {
  const result = await adminMutateGroupsAction({ changes });
  observeActionResult(result);
  if (!result.ok) throw new Error(result.error.message);
}
export async function adminMutateClients(
  changes: ActionArgs<"adminMutateClientsAction">[0]["changes"],
) {
  const result = await adminMutateClientsAction({ changes });
  observeActionResult(result);
  if (!result.ok) throw new Error(result.error.message);
}

// ── Clients ───────────────────────────────────────────────────────────────────

export type AdminClientRecord =
  ActionData<"adminFetchClientsAction">["clients"][number];

export async function adminFetchClients(offset = 0, query = "") {
  const result = await adminFetchClientsAction({ offset, q: query });
  observeActionResult(result);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.data;
}

export async function adminWhitelistCurrentClient() {
  const result = await adminWhitelistCurrentClientAction();
  const res = observeActionResult(result);
  return {
    res,
    data: result.ok ? result.data : { error: result.error.message },
  };
}

export async function adminDeleteBackup(name: string) {
  return observeActionResult(await adminDeleteBackupAction(name));
}

export function adminBackupDownloadUrl(token: string, name: string): string {
  return `/api/admin/system/backups/${encodeURIComponent(name)}?token=${encodeURIComponent(token)}`;
}

export async function adminDeployPackage(token: string, file: File) {
  const fd = new FormData();
  fd.append("file", file);
  return apiFetch("/api/admin/system/deploy", {
    method: "POST",
    headers: authHeaders(token),
    body: fd,
  });
}

// ── Config & system ───────────────────────────────────────────────────────────

export async function adminFetchConfig() {
  const result = await adminFetchConfigAction();
  observeActionResult(result);
  return result.ok ? result.data : null;
}

export async function adminUpdateConfig(
  body: ActionArgs<"adminUpdateConfigAction">[0],
) {
  const result = await adminUpdateConfigAction(body);
  const res = observeActionResult(result);
  return {
    res,
    data: result.ok ? result.data : { error: result.error.message },
  };
}

export async function adminFetchBackups() {
  const result = await adminFetchBackupsAction();
  observeActionResult(result);
  return result.ok ? result.data : null;
}

export async function adminCreateBackup() {
  const result = await adminCreateBackupAction();
  const res = observeActionResult(result);
  return {
    res,
    data: result.ok ? result.data : { error: result.error.message },
  };
}

export async function adminFetchUpdateStatus() {
  const result = await adminFetchUpdateStatusAction();
  observeActionResult(result);
  return result.ok ? result.data : null;
}

export async function adminFetchHttpsStatus() {
  const result = await adminFetchHttpsStatusAction();
  observeActionResult(result);
  return result.ok ? result.data : null;
}

export async function adminConfirmUpdate() {
  const result = await adminConfirmUpdateAction();
  const res = observeActionResult(result);
  return {
    res,
    data: result.ok ? result.data : { error: result.error.message },
  };
}

export async function adminRollback() {
  const result = await adminRollbackAction();
  return {
    res: observeActionResult(result),
    data: result.ok ? result.data : { error: result.error.message },
  };
}

// ── Tools ─────────────────────────────────────────────────────────────────────

export async function adminRunTool(action: "kill-wps" | "shutdown") {
  const result = await adminRunToolAction(action);
  const res = observeActionResult(result);
  const data: AdminToolData = result.ok
    ? result.data
    : { error: result.error.message };
  return {
    res,
    data,
  };
}

export type AdminTeachDocument =
  ActionData<"adminFetchTeachDocumentsAction">["documents"][number];

export async function adminFetchTeachDocuments() {
  const result = await adminFetchTeachDocumentsAction();
  observeActionResult(result);
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

export async function adminCleanupTeachDocuments() {
  const result = await adminCleanupTeachDocumentsAction();
  return {
    res: observeActionResult(result),
    data: result.ok ? result.data : { error: result.error.message },
  };
}

export type AdminIncidentGroup =
  ActionData<"adminFetchIncidentGroupsAction">["groups"][number];
export type AdminIncidentDetail =
  ActionData<"adminFetchIncidentDetailsAction">["incidents"][number];

export async function adminFetchIncidentGroups(input?: {
  environment?: "server" | "client";
  buildId?: string;
  offset?: number;
}) {
  const result = await adminFetchIncidentGroupsAction(input ?? {});
  observeActionResult(result);
  if (!result.ok) throw new Error(result.error.message);
  return result.data.groups;
}

export async function adminFetchIncidentDetails(groupId: number) {
  const result = await adminFetchIncidentDetailsAction(groupId);
  observeActionResult(result);
  if (!result.ok) throw new Error(result.error.message);
  return result.data.incidents;
}

export async function adminTestServerIncident(): Promise<never> {
  await adminTestIncidentAction();
  throw new Error("Incident test unexpectedly succeeded");
}

export function adminIncidentLogsDownloadUrl(token: string): string {
  return `/api/admin/incidents/logs?token=${encodeURIComponent(token)}`;
}

export function adminTeachDocumentDownloadUrl(
  token: string,
  id: string,
): string {
  return `/api/admin/teach-documents/${encodeURIComponent(id)}/download?token=${encodeURIComponent(token)}`;
}
