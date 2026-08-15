import { PublicError } from "@/server/services/incidentService";
import { expectString, withActionScope } from "./_base";
import type { ActionInput } from "@/shared/protocol/actions";

function parseOffset(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  throw new PublicError("offset 参数无效");
}

function parsePositiveHours(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  throw new PublicError(`${field} 参数无效`);
}

export async function adminFetchUsersAction(
  input?: ActionInput<"adminFetchUsersAction">,
) {
  return withActionScope(async (scope) => {
    const users = scope.facades().users();
    return users.list({
      q: typeof input?.q === "string" ? input.q : "",
      offset: parseOffset(input?.offset),
    });
  });
}

export async function adminCreateUserAction(
  input: ActionInput<"adminCreateUserAction">,
) {
  return withActionScope(async (scope) => {
    const users = scope.facades().users();
    if (input.ghost) {
      return scope.facades().ghostUsers().create();
    }
    return { user: await users.create(input) };
  });
}

export async function adminMutateUsersAction(
  input: ActionInput<"adminMutateUsersAction">,
) {
  return withActionScope(async (scope) => {
    const users = scope.facades().users();
    const ids = new Set<string>();
    for (const { removal, ...change } of input.changes) {
      if (ids.has(change.userId)) throw new PublicError("请求包含重复干员");
      ids.add(change.userId);
      if (removal) await users.remove(change.userId, removal);
      else {
        await users.update({
          ...change,
          mute_hours:
            change.mute_hours !== undefined
              ? parsePositiveHours(change.mute_hours, "mute_hours")
              : undefined,
          ban_hours:
            change.ban_hours !== undefined
              ? parsePositiveHours(change.ban_hours, "ban_hours")
              : undefined,
        });
      }
    }
    return { ok: true as const };
  });
}

export async function adminFetchAuditLogAction(
  input?: ActionInput<"adminFetchAuditLogAction">,
) {
  return withActionScope(async (scope) =>
    scope
      .facades()
      .audit()
      .list(input?.offset ?? 0),
  );
}

export async function adminFetchGhostUsersAction() {
  return withActionScope(async (scope) => {
    const ghostUsers = scope.facades().ghostUsers();
    return { ghosts: await ghostUsers.list() };
  });
}

export async function adminDeleteGhostUserAction(
  id: ActionInput<"adminDeleteGhostUserAction">,
) {
  return withActionScope(async (scope) => {
    const ghostUsers = scope.facades().ghostUsers();
    await ghostUsers.delete(expectString(id, "缺少 id"));
    return { ok: true as const };
  });
}

export async function adminFetchGroupsAction(
  input?: ActionInput<"adminFetchGroupsAction">,
) {
  return withActionScope(async (scope) => {
    return scope.facades().groups().adminList(parseOffset(input?.offset));
  });
}

export async function adminCreateGroupAction(
  input: ActionInput<"adminCreateGroupAction">,
) {
  return withActionScope(async (scope) => {
    return {
      group: await scope.facades().groups().adminCreate(input),
    };
  });
}

export async function adminMutateGroupsAction(
  input: ActionInput<"adminMutateGroupsAction">,
) {
  return withActionScope(async (scope) => {
    const groups = scope.facades().groups();
    const ids = new Set<string>();
    for (const {
      groupId,
      delete: shouldDelete,
      memberAction,
      userId,
      ...changes
    } of input.changes) {
      if (ids.has(groupId) && !memberAction)
        throw new PublicError("请求包含重复群组");
      ids.add(groupId);
      if (shouldDelete) await groups.adminDelete(groupId);
      else if (memberAction === "add") {
        await groups.adminAddMember(
          groupId,
          expectString(userId, "缺少 userId"),
        );
      } else if (memberAction === "remove") {
        await groups.adminRemoveMember(
          groupId,
          expectString(userId, "缺少 userId"),
        );
      } else await groups.adminUpdate(groupId, changes);
    }
    return { ok: true as const };
  });
}

export async function adminFetchClientsAction(
  input?: ActionInput<"adminFetchClientsAction">,
) {
  return withActionScope(async (scope) => {
    return scope
      .facades()
      .administration()
      .listClients(
        parseOffset(input?.offset),
        typeof input?.q === "string" ? input.q : "",
      );
  });
}

export async function adminMutateClientsAction(
  input: ActionInput<"adminMutateClientsAction">,
) {
  return withActionScope(async (scope) => {
    const administration = scope.facades().administration();
    const ids = new Set<string>();
    for (const update of input.changes) {
      if (ids.has(update.id)) throw new PublicError("请求包含重复客户端");
      ids.add(update.id);
      if (update.delete) {
        administration.deleteClient(update.id);
        continue;
      }
      if (update.promote) administration.promoteClient(update.id);
      if (update.locked !== undefined) {
        administration.setClientLock(update.id, update.locked);
      }
      if (
        update.remark !== undefined ||
        update.whitelisted !== undefined ||
        update.bound_user_id !== undefined
      ) {
        administration.updateClient(update.id, {
          remark: update.remark,
          whitelisted: update.whitelisted,
          bound_user_id: update.bound_user_id,
        });
      }
    }
    return { ok: true as const };
  });
}

export async function adminWhitelistCurrentClientAction() {
  return withActionScope(async (scope) => {
    return scope.facades().administration().whitelistCurrentClient();
  });
}

export async function adminFetchConfigAction() {
  return withActionScope(async (scope) => {
    return scope.facades().administration().getConfig();
  });
}

export async function adminUpdateConfigAction(
  input: ActionInput<"adminUpdateConfigAction">,
) {
  return withActionScope(async (scope) => {
    return scope.facades().administration().updateConfig(input);
  });
}

export async function adminFetchBackupsAction() {
  return withActionScope(async (scope) => {
    return scope.facades().administration().listBackups();
  });
}

export async function adminFetchHttpsStatusAction() {
  return withActionScope(async (scope) => {
    return scope.facades().administration().httpsStatus();
  });
}

export async function adminCreateBackupAction() {
  return withActionScope(async (scope) => {
    return scope.facades().administration().createBackup();
  });
}

export async function adminDeleteBackupAction(
  name: ActionInput<"adminDeleteBackupAction">,
) {
  return withActionScope(async (scope) => {
    return scope
      .facades()
      .administration()
      .deleteBackup(expectString(name, "文件名无效"));
  });
}

export async function adminFetchUpdateStatusAction() {
  return withActionScope(async (scope) => {
    return scope.facades().administration().updateStatus();
  });
}

export async function adminConfirmUpdateAction() {
  return withActionScope(async (scope) => {
    return scope.facades().administration().confirmUpdate();
  });
}

export async function adminRollbackAction() {
  return withActionScope(async (scope) => {
    return scope.facades().administration().rollback();
  });
}

export async function adminRunToolAction(
  action: ActionInput<"adminRunToolAction">,
) {
  return withActionScope(async (scope) => {
    return scope.facades().administration().runTool(action);
  });
}

export async function adminFetchTeachDocumentsAction() {
  return withActionScope(async (scope) => {
    return scope.facades().administration().listTeachDocuments();
  });
}

export async function adminCleanupTeachDocumentsAction() {
  return withActionScope(async (scope) => {
    return scope.facades().administration().cleanupTeachDocuments();
  });
}
