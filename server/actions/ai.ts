import type { ActionInput } from "@/shared/protocol/actions";
import { withActionScope } from "./_base";

export async function fetchAiSidebarAction() {
  return withActionScope(async (scope) => scope.facades().ai().list());
}

export async function fetchAiConversationAction(
  input: ActionInput<"fetchAiConversationAction">,
) {
  return withActionScope(async (scope) =>
    scope.facades().ai().detail(input.conversationId),
  );
}

export async function searchAiConversationsAction(
  input: ActionInput<"searchAiConversationsAction">,
) {
  return withActionScope(async (scope) =>
    scope.facades().ai().search(input.query),
  );
}

export async function startAiRunAction(input: ActionInput<"startAiRunAction">) {
  return withActionScope(
    async (scope) => await scope.facades().ai().start(input),
  );
}

export async function cancelAiRunAction(
  input: ActionInput<"cancelAiRunAction">,
) {
  return withActionScope(async (scope) =>
    scope.facades().ai().cancel(input.runId),
  );
}

export async function markAiConversationReadAction(
  input: ActionInput<"markAiConversationReadAction">,
) {
  return withActionScope(async (scope) =>
    scope.facades().ai().markRead(input.conversationId),
  );
}

export async function adminFetchAiCreditsAction(
  input: ActionInput<"adminFetchAiCreditsAction">,
) {
  return withActionScope(async (scope) =>
    scope.facades().ai().adminCredits(input.userId),
  );
}

export async function adminTopUpAiCreditsAction(
  input: ActionInput<"adminTopUpAiCreditsAction">,
) {
  return withActionScope(async (scope) => ({
    credits: await scope.facades().ai().adminTopUp(input),
  }));
}

export async function adminFetchAiBillingAction() {
  return withActionScope(async (scope) =>
    scope.facades().ai().adminBillingSummary(),
  );
}

export async function adminUpdateAiBillingPolicyAction(
  input: ActionInput<"adminUpdateAiBillingPolicyAction">,
) {
  return withActionScope(async (scope) =>
    scope.facades().ai().adminUpdateBillingPolicy(input),
  );
}

export async function adminAssignAiPlanAction(
  input: ActionInput<"adminAssignAiPlanAction">,
) {
  return withActionScope(async (scope) => ({
    credits: scope.facades().ai().adminAssignPlan(input),
  }));
}
