import * as admin from "@/server/actions/admin";
import * as announcement from "@/server/actions/announcement";
import * as app from "@/server/actions/app";
import * as articles from "@/server/actions/articles";
import * as auth from "@/server/actions/auth";
import * as conversations from "@/server/actions/conversations";
import * as groups from "@/server/actions/groups";
import * as incidents from "@/server/actions/incidents";
import * as notificationConfig from "@/server/actions/notification-config";
import * as posts from "@/server/actions/posts";
import * as stickers from "@/server/actions/stickers";
import * as userConfig from "@/server/actions/user-config";
import * as words from "@/server/actions/words";
import * as ai from "@/server/actions/ai";
import {
  actionContracts,
  type ActionArgs,
  type ActionData,
  type ActionHandlerFunctions,
  type ActionName,
} from "@/shared/protocol/actions";
import { ContractViolationError } from "@/server/services/incidentService";

const handlers = {
  ...admin,
  ...announcement,
  ...app,
  ...articles,
  ...auth,
  ...conversations,
  ...groups,
  ...incidents,
  ...notificationConfig,
  ...posts,
  ...stickers,
  ...userConfig,
  ...words,
  ...ai,
} satisfies ActionHandlerFunctions;

function invoke<K extends ActionName>(
  action: K,
  args: ActionArgs<K>,
): Promise<ActionData<K>> {
  // `action` and `args` have already been correlated by the contract parser.
  const handler = handlers[action] as (
    ...values: ActionArgs<K>
  ) => Promise<ActionData<K>>;
  return handler(...args);
}

/** Strict, contract-driven Action dispatch including server output validation. */
export async function dispatchAction<K extends ActionName>(
  action: K,
  rawArgs: unknown[],
): Promise<ActionData<K>> {
  const contract = actionContracts[action];
  const parsedArgs = contract.args.safeParse(rawArgs);
  if (!parsedArgs.success) {
    throw new ContractViolationError("请求格式错误", parsedArgs.error.issues);
  }

  const rawOutput = await invoke(action, parsedArgs.data as ActionArgs<K>);
  const parsedOutput = contract.output.safeParse(rawOutput);
  if (!parsedOutput.success) {
    console.error(
      `[ActionDispatcher] ${action} 返回值不符合契约`,
      parsedOutput.error.issues,
    );
    throw new ContractViolationError(
      `${action} 返回值不符合契约`,
      parsedOutput.error.issues,
    );
  }
  return parsedOutput.data as ActionData<K>;
}
