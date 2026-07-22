import {
  clampBlobReaderZoom,
  type BlobReaderConfig,
} from "@/shared/userConfig/reader";
import { expectBoolean, withActionSession } from "./_base";
import { MalformedRequestError } from "@/shared/protocol/errors";
import type { ActionInput } from "@/shared/protocol/actions";

export async function fetchReaderConfigAction() {
  return withActionSession(async (session) => {
    return (await (await session.asActor()).readerConfig()).get();
  });
}

export async function updateReaderConfigAction(
  input: ActionInput<"updateReaderConfigAction">,
) {
  return withActionSession(async (session) => {
    const patch: Partial<BlobReaderConfig> = {};
    if (input.grayscale !== undefined) {
      patch.grayscale = expectBoolean(input.grayscale, "grayscale 参数无效");
    }
    if (input.zoom !== undefined) {
      if (typeof input.zoom !== "number" || !Number.isFinite(input.zoom)) {
        throw new MalformedRequestError("zoom 参数无效");
      }
      patch.zoom = clampBlobReaderZoom(input.zoom);
    }
    return (await (await session.asActor()).readerConfig()).patch(patch);
  });
}
