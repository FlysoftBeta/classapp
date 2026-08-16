import { findReadyAsset, getTrack } from "@/server/data/media";
import { currentScope } from "@/server/runtime/scope";
import type { ObjectStore } from "@/server/storage/objectStore";
import { handleHttpError, PublicError } from "@/server/http/errorResponse";

/** Cover images use the normal session token query parameter, like other GET routes. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const scope = currentScope();
    scope.actor().requireFeature("media");
    const track = getTrack(scope.db, id);
    if (!track) throw new PublicError("曲目不存在");
    // Same acquire-before-read rule as audio: eviction never reclaims a file
    // while a stream holds its lease, and Windows rename is therefore safe.
    const releaseLease = scope.runtime.media.acquireLease(id);
    try {
      const ready = findReadyAsset(scope.db, id, "cover");
      if (ready?.object_path) {
        return await storedCoverResponse(
          scope.runtime.media.objects,
          ready.object_path,
          ready.mime ?? "image/jpeg",
          ready.bytes,
          releaseLease,
        );
      }
      void scope.runtime.media
        .ensureMaterialized(track, "cover")
        .catch(() => undefined);
      const becameReady = await scope.runtime.media.waitUntilReady(
        track,
        "cover",
        60_000,
      );
      if (!becameReady) throw new PublicError("封面尚未就绪");
      const nowReady = findReadyAsset(scope.db, id, "cover");
      if (!nowReady?.object_path) throw new PublicError("封面尚未就绪");
      return await storedCoverResponse(
        scope.runtime.media.objects,
        nowReady.object_path,
        nowReady.mime ?? "image/jpeg",
        nowReady.bytes,
        releaseLease,
      );
    } catch (error) {
      releaseLease();
      throw error;
    }
  } catch (error) {
    return handleHttpError(error);
  }
}

async function storedCoverResponse(
  objects: ObjectStore,
  objectKey: string,
  mime: string,
  bytes: number,
  releaseLease: () => void,
): Promise<Response> {
  const streamed = await objects.open(objects.ref("media", objectKey));
  const source = streamed.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await source.read();
        if (done) {
          releaseLease();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        releaseLease();
        await source.cancel(error).catch(() => undefined);
        controller.error(error);
      }
    },
    async cancel(reason) {
      releaseLease();
      await source.cancel(reason);
      return reason;
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": mime,
      "Content-Length": String(bytes),
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
