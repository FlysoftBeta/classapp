import type { Post } from "@/shared/types/api";
import type { ActionArgs, ActionData } from "@/shared/protocol/actions";
import { observeActionResult, apiFetch, authHeaders } from "./runtime";
import { client } from "@/client/interact/remote/client";

const {
  adminConfirmUpdateAction,
  adminCreateBackupAction,
  adminCreateGroupAction,
  adminCreateUserAction,
  adminDeleteBackupAction,
  adminDeleteClientAction,
  adminDeleteGhostUserAction,
  adminDeleteGroupAction,
  adminDeletePostAction,
  adminDeleteUserAction,
  adminFetchBackupsAction,
  adminFetchTeachDocumentsAction,
  adminFetchClientsAction,
  adminFetchConfigAction,
  adminFetchGhostUsersAction,
  adminFetchGroupsAction,
  adminFetchHttpsStatusAction,
  adminFetchPostsAction,
  adminFetchUpdateStatusAction,
  adminFetchUsersAction,
  adminPromoteClientAction,
  adminRollbackAction,
  adminRunToolAction,
  adminCleanupTeachDocumentsAction,
  adminToggleClientLockAction,
  adminUpdateClientAction,
  adminUpdateConfigAction,
  adminUpdateGroupAction,
  adminUpdateUserAction,
  adminWhitelistCurrentClientAction,
  adminFetchIncidentGroupsAction,
  adminFetchIncidentDetailsAction,
  adminTestIncidentAction,
  adminFetchAiCreditsAction,
  adminTopUpAiCreditsAction,
} = client.actions;

export type AdminMutationData = {
  error?: string;
};

export type AdminToolData = {
  message?: string;
  error?: string;
};

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

export async function adminUpdateUser(
  userId: string,
  body: Omit<ActionArgs<"adminUpdateUserAction">[0], "userId">,
) {
  const result = await adminUpdateUserAction({
    userId,
    ...body,
  });
  const res = observeActionResult(result);
  return {
    res,
    data: result.ok ? result.data : { error: result.error.message },
  };
}

export async function adminDeleteUser(
  userId: string,
  mode: "purge" | "deactivate",
) {
  return observeActionResult(await adminDeleteUserAction({ userId, mode }));
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

export async function adminTopUpAiCredits(input: {
  userId: string;
  amount: number;
  idempotencyKey: string;
  note: string;
}) {
  const result = await adminTopUpAiCreditsAction(input);
  observeActionResult(result);
  if (!result.ok) throw new Error(result.error.message);
  return result.data.credits;
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

export async function adminUpdateGroup(
  groupId: string,
  body: Omit<ActionArgs<"adminUpdateGroupAction">[0], "groupId">,
) {
  const result = await adminUpdateGroupAction({
    groupId,
    ...body,
  });
  const res = observeActionResult(result);
  return {
    res,
    data: result.ok ? result.data : { error: result.error.message },
  };
}

export async function adminDeleteGroup(groupId: string) {
  return observeActionResult(await adminDeleteGroupAction(groupId));
}

export async function adminAddGroupMember(groupId: string, userId: string) {
  const result = await adminUpdateGroupAction({
    groupId,
    action: "add_member",
    user_id: userId,
  });
  const res = observeActionResult(result);
  const data: AdminMutationData = result.ok
    ? {}
    : { error: result.error.message };
  return { res, data };
}

export async function adminRemoveGroupMember(groupId: string, userId: string) {
  return observeActionResult(
    await adminUpdateGroupAction({
      groupId,
      action: "remove_member",
      user_id: userId,
    }),
  );
}

// ── Posts ─────────────────────────────────────────────────────────────────────

export type AdminPostRecord = Post;

export async function adminFetchPosts(query: string, offset = 0, user = "") {
  const result = await adminFetchPostsAction({ q: query, offset, user });
  observeActionResult(result);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.data;
}

export async function adminDeletePost(postId: string) {
  return observeActionResult(await adminDeletePostAction(postId));
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

export async function adminDeleteClient(id: string) {
  return observeActionResult(await adminDeleteClientAction(id));
}

export async function adminToggleClientLock(id: string, lock: boolean) {
  return observeActionResult(
    await adminToggleClientLockAction({ id, action: lock ? "lock" : "unlock" }),
  );
}

export async function adminPromoteClient(id: string) {
  return observeActionResult(await adminPromoteClientAction(id));
}

export async function adminUpdateClient(
  body: ActionArgs<"adminUpdateClientAction">[0],
) {
  const result = await adminUpdateClientAction(body);
  return {
    res: observeActionResult(result),
    data: result.ok ? result.data : { error: result.error.message },
  };
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
