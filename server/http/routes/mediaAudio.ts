import { consumeStreamGrant } from "@/server/data/media";
import { findReadyAsset, getTrack } from "@/server/data/media";
import { currentScope } from "@/server/runtime/scope";
import { currentCoordinator } from "@/server/runtime/coordinator";
import {
  RangeNotSatisfiableError,
  type BlobReadRange,
  type BlobStore,
} from "@/server/storage/blobStore";
import { handleHttpError, PublicError } from "@/server/http/errorResponse";

/** Audio is a raw HTTP concern: grants replace headers the audio tag cannot send. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const url = new URL(req.url);
    const token = url.searchParams.get("grant");
    if (!token) throw new PublicError("缺少播放授权");
    const grant = consumeStreamGrant(currentScope().db, token);
    if (!grant || grant.trackId !== id)
      throw new PublicError("播放授权无效或已过期");

    const scope = currentScope();
    const track = getTrack(scope.db, id);
    if (!track) throw new PublicError("曲目不存在");

    // Acquire before reading the asset row. Eviction commits a row deletion
    // only while no lease exists, and a later acquisition sees no ready row,
    // so no stream can ever open a file that eviction is about to reclaim.
    const media = currentCoordinator().media;
    const releaseLease = media.acquireLease(id);

    try {
      const ready = findReadyAsset(scope.db, id, "audio");
      if (ready?.blob_id) {
        return await storedResponse(
          media.blobs,
          ready.blob_id,
          req,
          releaseLease,
        );
      }

      const range = parseRange(req.headers.get("range"));
      if (range === "unsatisfiable") {
        releaseLease();
        return new Response(null, { status: 416 });
      }
      const seekLike =
        range !== null &&
        (range.suffix === true ||
          range.start > 0 ||
          range.end !== Number.POSITIVE_INFINITY);
      if (seekLike) {
        const becameReady = await media.waitUntilReady(
          track,
          "audio",
          120_000,
        );
        if (!becameReady) {
          throw new PublicError("曲目尚未就绪，请稍后重试");
        }
        const nowReady = findReadyAsset(scope.db, id, "audio");
        if (!nowReady?.blob_id) throw new PublicError("曲目尚未就绪");
        return await storedResponse(
          media.blobs,
          nowReady.blob_id,
          req,
          releaseLease,
        );
      }

      // Open-ended start: relay yt-dlp stdout as a chunked WebM stream while a
      // background materialization job fills the shared cache.
      const handle = await media.streamTrack(track, req.signal);
      const iterator = handle.read()[Symbol.asyncIterator]();
      let pulling = false;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (pulling) return;
          pulling = true;
          try {
            const { value, done } = await iterator.next();
            pulling = false;
            if (done) {
              releaseLease();
              controller.close();
            } else {
              controller.enqueue(value);
            }
          } catch (error) {
            pulling = false;
            releaseLease();
            await handle.stop();
            controller.error(error);
          }
        },
        async cancel(reason) {
          releaseLease();
          await handle.stop();
          return reason;
        },
      });
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": "audio/webm",
          "Cache-Control": "no-store",
        },
      });
    } catch (error) {
      releaseLease();
      throw error;
    }
  } catch (error) {
    if (error instanceof RangeNotSatisfiableError) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${error.size}` },
      });
    }
    return handleHttpError(error);
  }
}

async function storedResponse(
  blobs: BlobStore,
  blobId: string,
  req: Request,
  releaseLease: () => void,
): Promise<Response> {
  const requested = parseRequestedRange(req.headers.get("range"));
  if (requested === "unsatisfiable") {
    releaseLease();
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": "bytes */0" },
    });
  }
  const selected = await blobs.open(blobId, requested ?? undefined);
  const size = selected.size;
  const range =
    requested === null
      ? null
      : {
          start: requestedStart(requested, size),
          end: requestedEnd(requested, size),
        };
  const length = range ? range.end - range.start + 1 : size;
  const source = selected.body.getReader();
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
    status: range ? 206 : 200,
    headers: {
      "Content-Type": "audio/webm",
      "Content-Length": String(length),
      "Accept-Ranges": "bytes",
      ...(range
        ? { "Content-Range": `bytes ${range.start}-${range.end}/${size}` }
        : {}),
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}

/**
 * Parse a single bytes range without knowing the asset size yet; BlobStore
 * resolves end/suffix against the same opened file descriptor used for the body.
 */
function parseRequestedRange(
  value: string | null,
): BlobReadRange | "unsatisfiable" | null {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return "unsatisfiable";
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return "unsatisfiable";
    }
    return { suffixLength };
  }
  const start = Number(match[1]);
  if (!Number.isSafeInteger(start) || start < 0) return "unsatisfiable";
  if (!match[2]) return { start };
  const end = Number(match[2]);
  if (!Number.isSafeInteger(end) || end < start) return "unsatisfiable";
  return { start, end };
}

function requestedStart(range: BlobReadRange, size: number): number {
  if (range.suffixLength !== undefined) {
    return Math.max(0, size - range.suffixLength);
  }
  return range.start ?? 0;
}

function requestedEnd(range: BlobReadRange, size: number): number {
  if (range.suffixLength !== undefined) return size - 1;
  return Math.min(range.end ?? size - 1, size - 1);
}

interface ByteRange {
  start: number;
  end: number;
  /** Set only for a suffix range whose size is not known yet. */
  suffix?: boolean;
}

function parseRange(
  value: string | null,
  size = Number.POSITIVE_INFINITY,
): ByteRange | "unsatisfiable" | null {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return "unsatisfiable";
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "unsatisfiable";
    // `bytes=-N` means "last N bytes"; that needs the eventual asset size,
    // so mark it as a seek and let the caller wait for materialization.
    if (size === Number.POSITIVE_INFINITY) {
      return { start: 0, end: size, suffix: true };
    }
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    // With an unknown size, `bytes=N-` stays open-ended instead of becoming
    // `N - Infinity`, which would make an ordinary audio probe unsatisfiable.
    end = match[2]
      ? Number(match[2])
      : size === Number.POSITIVE_INFINITY
        ? size
        : size - 1;
  }
  const openEnded = !match[2] && size === Number.POSITIVE_INFINITY;
  if (
    !Number.isSafeInteger(start) ||
    (!Number.isSafeInteger(end) && !openEnded) ||
    start < 0 ||
    end < start
  ) {
    return "unsatisfiable";
  }
  return {
    start,
    end: size === Number.POSITIVE_INFINITY ? end : Math.min(end, size - 1),
  };
}
