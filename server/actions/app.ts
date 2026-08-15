import { withActionScope, expectBoolean } from "./_base";
import type { ActionInput } from "@/shared/protocol/actions";

export async function probeAppStateAction(
  opts?: ActionInput<"probeAppStateAction">,
) {
  return withActionScope(async (scope) => {
    return scope
      .facades()
      .app()
      .probe(opts?.touch !== false);
  });
}

export async function getClientMeAction() {
  return withActionScope(async (scope) => {
    return scope.facades().app().clientMe();
  });
}

export async function patchClientMeAction(
  konami_locked: ActionInput<"patchClientMeAction">,
) {
  return withActionScope(async (scope) => {
    const locked = expectBoolean(konami_locked, "参数错误");
    return scope.facades().app().patchClientMe(locked);
  });
}
