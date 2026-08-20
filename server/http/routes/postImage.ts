import { handleHttpError, PublicError } from "@/server/http/errorResponse";
import { currentScope } from "@/server/runtime/scope";
import { currentCoordinator } from "@/server/runtime/coordinator";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; variant: string }> },
) {
  try {
    const { id, variant } = await params;
    if (variant !== "original" && variant !== "thumb") {
      throw new PublicError("未知的图片资源");
    }
    const scope = currentScope();
    const posts = scope.facades().posts();
    const runtime = currentCoordinator().postImages;
    const releaseLease = runtime.acquireLease(id);
    try {
      if (variant === "original") {
        const selected = await posts.streamOriginal(id);
        return await blobResponse(
          selected.read.body,
          selected.image.mime,
          selected.image.bytes,
          releaseLease,
        );
      }
      const existing = await posts.streamThumb(id);
      if (existing) {
        return await blobResponse(
          existing.read.body,
          existing.image.thumb.mime ?? "image/webp",
          existing.image.thumb.bytes,
          releaseLease,
        );
      }
      const becameReady = await runtime.waitUntilReady(id);
      if (!becameReady) throw new PublicError("缩略图尚未就绪");
      const nowReady = await posts.streamThumb(id);
      if (!nowReady) throw new PublicError("缩略图尚未就绪");
      return await blobResponse(
        nowReady.read.body,
        nowReady.image.thumb.mime ?? "image/webp",
        nowReady.image.thumb.bytes,
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

async function blobResponse(
  body: ReadableStream<Uint8Array>,
  mime: string,
  bytes: number,
  releaseLease: () => void,
): Promise<Response> {
  const source = body.getReader();
  const streamed = new ReadableStream<Uint8Array>({
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
  return new Response(streamed, {
    status: 200,
    headers: {
      "Content-Type": mime,
      "Content-Length": String(bytes),
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
