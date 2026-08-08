import type { CreatePostPayload } from "@/shared/validation/posts";
import { observeActionResult } from "./runtime";
import { client } from "@/client/lib/remote/client";

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
  const data = result.ok ? result.data : { error: result.error.message };
  return { res, data };
}
