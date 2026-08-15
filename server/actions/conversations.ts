import { withActionScope, expectBoolean, expectString } from "./_base";
import { ContractViolationError } from "@/server/services/incidentService";
import type { ActionInput } from "@/shared/protocol/actions";

type ConversationRef = ActionInput<"fetchConversationDraftAction">;

function expectConversation(input: ConversationRef): ConversationRef {
  const type = input?.type;
  if (type !== "group" && type !== "dm") {
    throw new ContractViolationError("非法会话类型");
  }
  return {
    type,
    id: expectString(input?.id, "参数不完整"),
  };
}

export async function fetchConversationsAction() {
  return withActionScope(async (scope) => {
    return scope.facades().conversations().list();
  });
}

export async function fetchConversationRevisionsAction() {
  return withActionScope(async (scope) => ({
    revisions: await scope.facades().conversations().revisions(),
  }));
}

export async function markConversationReadAction(
  input: ActionInput<"markConversationReadAction">,
) {
  return withActionScope(async (scope) => {
    const conversation = expectConversation(input);
    return await scope
      .facades()
      .conversations()
      .markRead({
        ...conversation,
        postId: expectString(input.post_id, "参数不完整"),
        updatedAt: expectTimestamp(input.updatedAt),
        merge: input.merge,
      });
  });
}

export async function setConversationPinnedAction(
  input: ActionInput<"setConversationPinnedAction">,
) {
  return withActionScope(async (scope) => {
    const conversation = expectConversation(input);
    return await scope
      .facades()
      .conversations()
      .setPinned({
        ...conversation,
        pinned: expectBoolean(input.pinned, "pinned 必须为布尔值"),
        updatedAt: expectTimestamp(input.updatedAt),
      });
  });
}

export async function setConversationMutedAction(
  input: ActionInput<"setConversationMutedAction">,
) {
  return withActionScope(async (scope) => {
    const conversation = expectConversation(input);
    return await scope
      .facades()
      .conversations()
      .setMuted({
        ...conversation,
        muted: expectBoolean(input.muted, "muted 必须为布尔值"),
        updatedAt: expectTimestamp(input.updatedAt),
      });
  });
}

function expectTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new ContractViolationError("配置时间戳无效");
  return value;
}

export async function fetchConversationDraftAction(input: ConversationRef) {
  return withActionScope(async (scope) => {
    return scope.facades().conversations().getDraft(expectConversation(input));
  });
}

export async function saveConversationDraftAction(
  input: ActionInput<"saveConversationDraftAction">,
) {
  return withActionScope(async (scope) => {
    const conversation = expectConversation(input);
    const draft = expectString(input.draft, "draft 必须为字符串", {
      trim: false,
    });
    if (!Number.isFinite(input.updatedAt) || input.updatedAt < 0) {
      throw new ContractViolationError("草稿时间戳无效");
    }
    return await scope
      .facades()
      .conversations()
      .saveDraft({
        ...conversation,
        draft,
        updatedAt: input.updatedAt,
      });
  });
}
