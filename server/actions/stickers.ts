import { expectString, withActionScope } from "./_base";
import type { ActionInput } from "@/shared/protocol/actions";

export async function fetchStickerPacksAction() {
  return withActionScope(async (scope) => ({
    packs: scope.facades().stickers().listPacks(),
  }));
}

export async function fetchStickerPackAction(
  packId: ActionInput<"fetchStickerPackAction">,
) {
  return withActionScope(async (scope) => {
    return {
      pack: scope
        .facades()
        .stickers()
        .getPack(expectString(packId, "贴纸包不存在")),
    };
  });
}

export async function fetchRecentStickersAction() {
  return withActionScope(async (scope) => {
    return {
      recent: await scope.facades().stickers().getRecent(),
    };
  });
}

export async function touchRecentStickerAction(
  input: ActionInput<"touchRecentStickerAction">,
) {
  return withActionScope(async (scope) => {
    return {
      recent: await scope
        .facades()
        .stickers()
        .touchRecent(
          expectString(input.pack, "贴纸参数无效"),
          expectString(input.id, "贴纸参数无效"),
        ),
    };
  });
}

export async function sendStickerPostAction(
  input: ActionInput<"sendStickerPostAction">,
) {
  return withActionScope(async (scope) =>
    scope.facades().posts().create(input),
  );
}
