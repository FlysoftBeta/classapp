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

export async function adminUpdateUserAction(
  input: ActionInput<"adminUpdateUserAction">,
) {
  return withActionScope(async (scope) => {
    const users = scope.facades().users();
    return {
      user: await users.update({
        userId: expectString(input.userId, "干员不存在"),
        handle: input.handle,
        username: input.username,
        features: input.features,
        roles: input.roles,
        pin: input.pin,
        mute_hours:
          input.mute_hours !== undefined
            ? parsePositiveHours(input.mute_hours, "mute_hours")
            : undefined,
        unmute: input.unmute,
        ban_hours:
          input.ban_hours !== undefined
            ? parsePositiveHours(input.ban_hours, "ban_hours")
            : undefined,
        unban: input.unban,
      }),
    };
  });
}

export async function adminBatchUpdateUserFeaturesAction(
  input: ActionInput<"adminBatchUpdateUserFeaturesAction">,
) {
  return withActionScope(async (scope) =>
    scope.facades().users().batchUpdateFeatures(input.updates),
  );
}

export async function adminDeleteUserAction(
  input: ActionInput<"adminDeleteUserAction">,
) {
  return withActionScope(async (scope) => {
    const users = scope.facades().users();
    await users.remove(expectString(input.userId, "干员不存在"), input.mode);
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

export async function adminUpdateGroupAction(
  input: ActionInput<"adminUpdateGroupAction">,
) {
  return withActionScope(async (scope) => {
    const groups = scope.facades().groups();
    const groupId = expectString(input.groupId, "群组不存在");
    if (input.action === "add_member") {
      await groups.adminAddMember(
        groupId,
        expectString(input.user_id, "缺少 user_id"),
      );
      return { ok: true as const };
    }
    if (input.action === "remove_member") {
      await groups.adminRemoveMember(
        groupId,
        expectString(input.user_id, "缺少 user_id"),
      );
      return { ok: true as const };
    }
    return {
      group: await groups.adminUpdate(groupId, {
        handle: input.handle,
        name: input.name,
        password: input.password,
        clearPassword: input.clearPassword,
        type: input.type,
        discoverable: input.discoverable,
        members_hidden: input.members_hidden,
        admin_only: input.admin_only,
        no_leave: input.no_leave,
        parent_group_id: input.parent_group_id,
      }),
    };
  });
}

export async function adminDeleteGroupAction(
  groupId: ActionInput<"adminDeleteGroupAction">,
) {
  return withActionScope(async (scope) => {
    await scope
      .facades()
      .groups()
      .adminDelete(expectString(groupId, "群组不存在"));
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

export async function adminToggleClientLockAction(
  input: ActionInput<"adminToggleClientLockAction">,
) {
  return withActionScope(async (scope) => {
    const id = expectString(input.id, "缺少 id");
    return scope
      .facades()
      .administration()
      .setClientLock(id, input.action === "lock");
  });
}

export async function adminDeleteClientAction(
  id: ActionInput<"adminDeleteClientAction">,
) {
  return withActionScope(async (scope) => {
    return scope
      .facades()
      .administration()
      .deleteClient(expectString(id, "缺少 id"));
  });
}

export async function adminPromoteClientAction(
  id: ActionInput<"adminPromoteClientAction">,
) {
  return withActionScope(async (scope) => {
    return scope
      .facades()
      .administration()
      .promoteClient(expectString(id, "缺少 id"));
  });
}

export async function adminUpdateClientAction(
  input: ActionInput<"adminUpdateClientAction">,
) {
  return withActionScope(async (scope) => {
    return scope
      .facades()
      .administration()
      .updateClient(expectString(input.id, "缺少 id"), {
        remark: input.remark,
        whitelisted: input.whitelisted,
        bound_user_id: input.bound_user_id,
      });
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
