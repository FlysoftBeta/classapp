import { withActionScope } from "@/server/actions/_base";
import type { ActionInput } from "@/shared/protocol/actions";

export async function reportClientIncidentAction(
  input: ActionInput<"reportClientIncidentAction">,
) {
  return withActionScope(async (scope) => {
    return scope.facades().incidents().reportClient(input);
  });
}

export async function adminFetchIncidentGroupsAction(
  input?: ActionInput<"adminFetchIncidentGroupsAction">,
) {
  return withActionScope(async (scope) => {
    return scope
      .facades()
      .incidents()
      .list(input ?? {});
  });
}

export async function adminFetchIncidentDetailsAction(
  groupId: ActionInput<"adminFetchIncidentDetailsAction">,
) {
  return withActionScope(async (scope) => {
    return scope.facades().incidents().details(groupId);
  });
}

export async function adminTestIncidentAction() {
  return withActionScope(async (scope) => {
    return scope.facades().incidents().test();
  });
}
