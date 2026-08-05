import { getDb } from "@/server/infra/db";
import { createAdminSystemService } from "@/server/services/adminSystemService";
import { createClientService } from "@/server/services/clientsService";
import { ServiceError } from "@/server/services/errors";
import { createAppStateService } from "@/server/services/appStateService";
import { createHttpsUpgradeService } from "@/server/services/httpsUpgradeService";
import { createAnnouncementService } from "@/server/services/announcementService";
import { createTeachDocumentsService } from "@/server/services/teachDocumentsService";
import { expectBoolean, expectString, withActionSession } from "./_base";
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
  throw new ServiceError("offset 参数无效", 400);
}

function parsePositiveHours(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  throw new ServiceError(`${field} 参数无效`, 400);
}

export async function adminFetchUsersAction(
  input?: ActionInput<"adminFetchUsersAction">,
) {
  return withActionSession(async (session) => {
    const users = await (await session.asActor()).users();
    return users.list({
      q: typeof input?.q === "string" ? input.q : "",
      offset: parseOffset(input?.offset),
    });
  });
}

export async function adminCreateUserAction(
  input: ActionInput<"adminCreateUserAction">,
) {
  return withActionSession(async (session) => {
    const actor = await session.asActor();
    const users = await actor.users();
    if (input.ghost) {
      return (await actor.ghostUsers()).create();
    }
    return { user: await users.create(input) };
  });
}

export async function adminUpdateUserAction(
  input: ActionInput<"adminUpdateUserAction">,
) {
  return withActionSession(async (session) => {
    const users = await (await session.asActor()).users();
    return {
      user: await users.update({
        userId: expectString(input.userId, "干员不存在"),
        handle: input.handle,
        username: input.username,
        feature_mask: input.feature_mask,
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

export async function adminDeleteUserAction(
  input: ActionInput<"adminDeleteUserAction">,
) {
  return withActionSession(async (session) => {
    const users = await (await session.asActor()).users();
    await users.remove(expectString(input.userId, "干员不存在"), input.mode);
    return { ok: true as const };
  });
}

export async function adminFetchGhostUsersAction() {
  return withActionSession(async (session) => {
    const ghostUsers = await (await session.asActor()).ghostUsers();
    return { ghosts: await ghostUsers.list() };
  });
}

export async function adminDeleteGhostUserAction(
  id: ActionInput<"adminDeleteGhostUserAction">,
) {
  return withActionSession(async (session) => {
    const ghostUsers = await (await session.asActor()).ghostUsers();
    await ghostUsers.delete(expectString(id, "缺少 id"));
    return { ok: true as const };
  });
}

export async function adminFetchGroupsAction(
  input?: ActionInput<"adminFetchGroupsAction">,
) {
  return withActionSession(async (session) => {
    const actor = await session.asActor();
    return (await actor.groups()).adminList(parseOffset(input?.offset));
  });
}

export async function adminCreateGroupAction(
  input: ActionInput<"adminCreateGroupAction">,
) {
  return withActionSession(async (session) => {
    const actor = await session.asActor();
    return {
      group: await (await actor.groups()).adminCreate(input),
    };
  });
}

export async function adminUpdateGroupAction(
  input: ActionInput<"adminUpdateGroupAction">,
) {
  return withActionSession(async (session) => {
    const actor = await session.asActor();
    const groups = await actor.groups();
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
  return withActionSession(async (session) => {
    const actor = await session.asActor();
    await (
      await actor.groups()
    ).adminDelete(expectString(groupId, "群组不存在"));
    return { ok: true as const };
  });
}

export async function adminFetchPostsAction(
  input?: ActionInput<"adminFetchPostsAction">,
) {
  return withActionSession(async (session) => {
    const actor = await session.asActor();
    return (await actor.posts()).adminList({
      q: typeof input?.q === "string" ? input.q : "",
      userId: typeof input?.user === "string" ? input.user : "",
      offset: parseOffset(input?.offset),
    });
  });
}

export async function adminDeletePostAction(
  postId: ActionInput<"adminDeletePostAction">,
) {
  return withActionSession(async (session) => {
    const actor = await session.asActor();
    await (await actor.posts()).adminDelete(expectString(postId, "帖子不存在"));
    return { ok: true as const };
  });
}

export async function adminFetchClientsAction(
  input?: ActionInput<"adminFetchClientsAction">,
) {
  return withActionSession(async (session) => {
    const actor = await session.asActor();
    await actor.requireAdmin();
    return createClientService(getDb()).list(
      parseOffset(input?.offset),
      50,
      typeof input?.q === "string" ? input.q : "",
    );
  });
}

export async function adminToggleClientLockAction(
  input: ActionInput<"adminToggleClientLockAction">,
) {
  return withActionSession(async (session) => {
    const actor = await session.asActor();
    await actor.requireAdmin();
    const clients = createClientService(getDb());
    const id = expectString(input.id, "缺少 id");
    if (input.action === "lock") {
      clients.lock(id);
    } else if (input.action === "unlock") {
      try {
        clients.unlock(id);
      } catch (error) {
        throw new ServiceError(
          error instanceof Error ? error.message : "无法加入白名单",
          400,
        );
      }
    } else {
      throw new ServiceError("无效 action", 400);
    }
    return { ok: true as const };
  });
}

export async function adminDeleteClientAction(
  id: ActionInput<"adminDeleteClientAction">,
) {
  return withActionSession(async (session) => {
    const actor = await session.asActor();
    await actor.requireAdmin();
    const deleted = createClientService(getDb()).delete(
      expectString(id, "缺少 id"),
    );
    if (!deleted) {
      throw new ServiceError("客户端不存在", 404);
    }
    return { ok: true as const };
  });
}

export async function adminPromoteClientAction(
  id: ActionInput<"adminPromoteClientAction">,
) {
  return withActionSession(async (session) => {
    const actor = await session.asActor();
    await actor.requireAdmin();
    try {
      createClientService(getDb()).promote(expectString(id, "缺少 id"));
    } catch (error) {
      throw new ServiceError(
        error instanceof Error ? error.message : "无法保留客户端",
        400,
      );
    }
    return { ok: true as const };
  });
}

export async function adminUpdateClientAction(
  input: ActionInput<"adminUpdateClientAction">,
) {
  return withActionSession(async (session) => {
    const actor = await session.asActor();
    await actor.requireAdmin();
    try {
      createClientService(getDb()).updateProps(
        expectString(input.id, "缺少 id"),
        {
          remark: input.remark,
          whitelisted: input.whitelisted,
          bound_user_id: input.bound_user_id,
        },
      );
    } catch (error) {
      throw new ServiceError(
        error instanceof Error ? error.message : "客户端属性保存失败",
        400,
      );
    }
    return { ok: true as const };
  });
}

export async function adminWhitelistCurrentClientAction() {
  return withActionSession(async (session) => {
    const actor = await session.asActor();
    await actor.requireAdmin();
    const clientId = await actor.clientId();
    if (!clientId) {
      throw new ServiceError("无法识别当前设备，请刷新页面后重试", 400);
    }
    try {
      const clients = createClientService(getDb());
      clients.promote(clientId);
      clients.whitelist(clientId);
    } catch (error) {
      throw new ServiceError(
        error instanceof Error ? error.message : "无法加入白名单",
        400,
      );
    }
    return { ok: true as const, client_id: clientId };
  });
}

export async function adminFetchConfigAction() {
  return withActionSession(async (session) => {
    const actor = await session.asActor();
    await actor.requireAdmin();
    const db = getDb();
    const announcement = createAnnouncementService(db).get();
    return {
      ...createAppStateService(db).getConfig(),
      https_redirect_enabled: createHttpsUpgradeService(db).isRedirectEnabled(),
      ...createClientService(db).config(),
      announcement_content: announcement.content,
      announcement_revision: announcement.revision,
    };
  });
}

export async function adminUpdateConfigAction(
  input: ActionInput<"adminUpdateConfigAction">,
) {
  return withActionSession(async (session) => {
    const actor = await session.asActor();
    await actor.requireAdmin();
    const db = getDb();
    const appConfig = createAppStateService(db).updateConfig({
      idle_lock_enabled:
        input.idle_lock_enabled !== undefined
          ? expectBoolean(
              input.idle_lock_enabled,
              "idle_lock_enabled must be boolean",
            )
          : undefined,
      system_locked:
        input.system_locked !== undefined
          ? expectBoolean(input.system_locked, "system_locked must be boolean")
          : undefined,
    });
    const https = createHttpsUpgradeService(db);
    if (input.https_redirect_enabled !== undefined) {
      https.setRedirectEnabled(
        expectBoolean(
          input.https_redirect_enabled,
          "https_redirect_enabled must be boolean",
        ),
      );
    }
    const clientConfig = createClientService(db).updateConfig({
      whitelist_enabled: input.whitelist_enabled,
      identity_methods: input.identity_methods,
    });
    const announcements = createAnnouncementService(db);
    const announcement =
      input.announcement_content !== undefined
        ? announcements.update(input.announcement_content)
        : announcements.get();
    return {
      ok: true as const,
      ...appConfig,
      https_redirect_enabled: https.isRedirectEnabled(),
      ...clientConfig,
      announcement_content: announcement.content,
      announcement_revision: announcement.revision,
    };
  });
}

export async function adminFetchBackupsAction() {
  return withActionSession(async (session) => {
    const actor = await session.asActor();
    await actor.requireAdmin();
    return { backups: createAdminSystemService(getDb()).listBackups() };
  });
}

export async function adminFetchHttpsStatusAction() {
  return withActionSession(async (session) => {
    const actor = await session.asActor();
    await actor.requireAdmin();
    return createAdminSystemService(getDb()).getHttpsStatus();
  });
}

export async function adminCreateBackupAction() {
  return withActionSession(async (session) => {
    const actor = await session.asActor();
    await actor.requireAdmin();
    return {
      ok: true as const,
      backups: await createAdminSystemService(getDb()).createBackup(),
    };
  });
}

export async function adminDeleteBackupAction(
  name: ActionInput<"adminDeleteBackupAction">,
) {
  return withActionSession(async (session) => {
    const actor = await session.asActor();
    await actor.requireAdmin();
    createAdminSystemService(getDb()).deleteBackup(
      expectString(name, "文件名无效"),
    );
    return { ok: true as const };
  });
}

export async function adminFetchUpdateStatusAction() {
  return withActionSession(async (session) => {
    const actor = await session.asActor();
    await actor.requireAdmin();
    return createAdminSystemService(getDb()).getUpdateStatus();
  });
}

export async function adminConfirmUpdateAction() {
  return withActionSession(async (session) => {
    const actor = await session.asActor();
    await actor.requireAdmin();
    createAdminSystemService(getDb()).confirmUpdate();
    return { ok: true as const };
  });
}

export async function adminRollbackAction() {
  return withActionSession(async (session) => {
    const actor = await session.asActor();
    await actor.requireAdmin();
    return createAdminSystemService(getDb()).rollback();
  });
}

export async function adminRunToolAction(
  action: ActionInput<"adminRunToolAction">,
) {
  return withActionSession(async (session) => {
    const actor = await session.asActor();
    await actor.requireAdmin();
    return createAdminSystemService(getDb()).runTool(action);
  });
}

export async function adminFetchTeachDocumentsAction() {
  return withActionSession(async (session) => {
    const actor = await session.asActor();
    await actor.requireAdmin();
    return {
      documents: createTeachDocumentsService(getDb())
        .list()
        .map((document) => ({
          id: document.id,
          application: document.application,
          document_type: document.document_type,
          name: document.name,
          file_size: document.file_size,
          created_at: document.created_at,
        })),
      monitor_available: process.platform === "win32",
    };
  });
}

export async function adminCleanupTeachDocumentsAction() {
  return withActionSession(async (session) => {
    const actor = await session.asActor();
    await actor.requireAdmin();
    const deleted = await createTeachDocumentsService(getDb()).cleanupAll();
    return { ok: true as const, deleted };
  });
}
