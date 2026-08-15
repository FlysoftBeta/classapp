import { expectBoolean, expectString, withActionScope } from "./_base";
import type { ActionInput } from "@/shared/protocol/actions";

export async function createGroupAction(
  input: ActionInput<"createGroupAction">,
) {
  return withActionScope(async (scope) => {
    const groups = scope.facades().groups();
    const discoverable =
      input.discoverable === undefined
        ? undefined
        : expectBoolean(input.discoverable, "discoverable must be boolean");
    const name = expectString(input.name, "群组名称不能为空");
    const handle =
      input.handle === undefined
        ? undefined
        : expectString(input.handle, "群组 handle 无效");
    const password =
      input.password === undefined
        ? undefined
        : expectString(input.password, "群组密码无效", { trim: false });
    const parentGroupId =
      input.parent_group_id === null
        ? null
        : input.parent_group_id === undefined
          ? undefined
          : expectString(input.parent_group_id, "父群组无效");

    return {
      group: await groups.create({
        handle,
        name,
        password,
        discoverable,
        parent_group_id: discoverable ? (parentGroupId ?? null) : null,
      }),
    };
  });
}

export async function discoverGroupsAction(
  input?: ActionInput<"discoverGroupsAction">,
) {
  return withActionScope(async (scope) => {
    return {
      sections: await scope
        .facades()
        .groups()
        .discoverSections(typeof input?.query === "string" ? input.query : ""),
    };
  });
}

export async function discoverSubgroupsAction(
  input: ActionInput<"discoverSubgroupsAction">,
) {
  return withActionScope(async (scope) => {
    const groups = scope.facades().groups();
    return {
      groups: await groups.discoverSubgroups(
        expectString(input.groupId, "群组不存在"),
        typeof input.query === "string" ? input.query : "",
      ),
    };
  });
}

export async function joinGroupAction(input: ActionInput<"joinGroupAction">) {
  return withActionScope(async (scope) => {
    const groups = scope.facades().groups();
    const source =
      input.source.type === "search"
        ? ({ type: "search" } as const)
        : ({
            type: "group",
            groupId: expectString(input.source.groupId, "群组发现来源无效"),
          } as const);
    return groups.join(
      expectString(input.groupId, "群组不存在"),
      source,
      typeof input.password === "string" ? input.password : undefined,
    );
  });
}

export async function leaveGroupAction(
  groupId: ActionInput<"leaveGroupAction">,
) {
  return withActionScope(async (scope) => {
    await scope.facades().groups().leave(expectString(groupId, "群组不存在"));
    return { ok: true as const };
  });
}

export async function fetchGroupMembersAction(
  groupId: ActionInput<"fetchGroupMembersAction">,
) {
  return withActionScope(async (scope) => {
    const result = await scope
      .facades()
      .groups()
      .members(expectString(groupId, "群组不存在"));
    return {
      members: result.members,
      users: result.users,
      hidden: result.hidden,
      no_leave: result.no_leave,
      self_hide_self: result.self_hide_self,
    };
  });
}

export async function patchMyGroupMembershipAction(
  input: ActionInput<"patchMyGroupMembershipAction">,
) {
  return withActionScope(async (scope) => {
    const hideSelf = expectBoolean(
      input.hide_self,
      "hide_self must be boolean",
    );
    await scope
      .facades()
      .groups()
      .setSelfHidden(expectString(input.groupId, "群组不存在"), hideSelf);
    return { ok: true as const, hide_self: hideSelf };
  });
}
