import { observeActionResult } from "./runtime";
import type { ActionArgs } from "@/shared/protocol/actions";
import { client } from "@/client/lib/remote/client";

const {
  createGroupAction,
  discoverGroupsAction,
  discoverSubgroupsAction,
  fetchGroupMembersAction,
  joinGroupAction,
  leaveGroupAction,
  patchMyGroupMembershipAction,
} = client.actions;

export interface GroupMember {
  id: string;
  handle: string;
  username: string;
  hide_self?: number;
}

export interface GroupMembersPayload {
  members?: GroupMember[];
  hidden?: boolean;
  no_leave?: boolean;
  self_hide_self?: boolean;
}

export interface DiscoverySection {
  parent: { id: string; name: string };
  groups: {
    id: string;
    handle: string;
    name: string;
    has_password: number;
  }[];
}

export type CreateGroupData = {
  group?: { id: string; name: string };
  error?: string;
};

export type JoinGroupData = {
  error?: string;
  needs_password?: boolean;
};

export type LeaveGroupData = {
  error?: string;
};

export async function createGroup(body: ActionArgs<"createGroupAction">[0]) {
  const result = await createGroupAction(body);
  const res = observeActionResult(result);
  const data: CreateGroupData = result.ok
    ? result.data
    : { error: result.error.message };
  return { res, data };
}

export async function discoverGroups(query?: string) {
  const result = await discoverGroupsAction({ query });
  observeActionResult(result);
  return result.ok ? result.data : null;
}

export async function discoverSubgroups(groupId: string) {
  const result = await discoverSubgroupsAction({ groupId });
  observeActionResult(result);
  return result.ok ? result.data : null;
}

export async function joinGroup(
  groupId: string,
  source: { type: "search" } | { type: "group"; groupId: string },
  password?: string,
) {
  const result = await joinGroupAction({
    groupId,
    source,
    password: password || undefined,
  });
  const res = observeActionResult(result);
  const data: JoinGroupData = result.ok
    ? {}
    : {
        error: result.error.message,
        needs_password:
          result.error.kind === "checked" &&
          result.error.status === 403 &&
          result.error.message.includes("密码"),
      };
  return { res, data };
}

export async function leaveGroup(groupId: string) {
  const result = await leaveGroupAction(groupId);
  const res = observeActionResult(result);
  const data: LeaveGroupData = result.ok ? {} : { error: result.error.message };
  return { res, data };
}

export async function fetchGroupMembers(groupId: string) {
  const result = await fetchGroupMembersAction(groupId);
  observeActionResult(result);
  return result.ok ? result.data : null;
}

export async function patchMyGroupMembership(
  groupId: string,
  body: { hide_self: boolean },
) {
  return observeActionResult(
    await patchMyGroupMembershipAction({
      groupId,
      hide_self: body.hide_self,
    }),
  );
}
