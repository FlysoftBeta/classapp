import { expectString, withActionSession } from "./_base";
import type { ActionInput } from "@/shared/protocol/actions";

export async function fetchStickerPacksAction() {
  return withActionSession(async (session) => ({
    packs: (await (await session.asActor()).stickers()).listPacks(),
  }));
}

export async function fetchStickerPackAction(
  packId: ActionInput<"fetchStickerPackAction">,
) {
  return withActionSession(async (session) => {
    return {
      pack: (await (await session.asActor()).stickers()).getPack(
        expectString(packId, "贴纸包不存在"),
      ),
    };
  });
}

export async function fetchRecentStickersAction() {
  return withActionSession(async (session) => {
    return {
      recent: await (await (await session.asActor()).stickers()).getRecent(),
    };
  });
}

export async function touchRecentStickerAction(
  input: ActionInput<"touchRecentStickerAction">,
) {
  return withActionSession(async (session) => {
    return {
      recent: await (
        await (await session.asActor()).stickers()
      ).touchRecent(
        expectString(input.pack, "贴纸参数无效"),
        expectString(input.id, "贴纸参数无效"),
      ),
    };
  });
}

export async function sendStickerPostAction(
  input: ActionInput<"sendStickerPostAction">,
) {
  return withActionSession(async (session) => ({
    post: await (await (await session.asActor()).posts()).create(input),
  }));
}
