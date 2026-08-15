import type { CreatePostPayload } from "@/shared/validation/posts";
import { observeActionResult } from "./runtime";
import { client } from "@/client/interact/remote/client";
import { currentActorRepository } from "@/client/interact/actorContext";
import { materializePost } from "@/client/interact/posts";

const {
  fetchRecentStickersAction,
  fetchStickerPackAction,
  fetchStickerPacksAction,
  sendStickerPostAction,
} = client.actions;

export async function fetchStickerPacks() {
  const result = await fetchStickerPacksAction();
  const res = observeActionResult(result);
  const data = result.ok ? result.data : { error: result.error.message };
  return { res, data };
}

export async function fetchStickerPack(packId: string) {
  const result = await fetchStickerPackAction(packId);
  const res = observeActionResult(result);
  const data = result.ok ? result.data : { error: result.error.message };
  return { res, data };
}

export async function fetchRecentStickers() {
  const result = await fetchRecentStickersAction();
  const res = observeActionResult(result);
  const data = result.ok ? result.data : { error: result.error.message };
  return { res, data };
}

export async function sendStickerPost(body: {
  content: Extract<CreatePostPayload, { type: "sticker" }>;
  conv_id: string;
  reply_to?: string;
}) {
  const result = await sendStickerPostAction(body);
  const res = observeActionResult(result);
  if (result.ok) {
    await currentActorRepository.saveUserMetadata(result.data.users);
  }
  const data = result.ok
    ? {
        ...result.data,
        post: materializePost(result.data.post, result.data.users),
      }
    : { error: result.error.message };
  return { res, data };
}
