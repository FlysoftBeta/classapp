import {
  RangeNotSatisfiableError,
  type BlobReadRange,
} from "@/server/storage/blobStore";
import { handleHttpError } from "@/server/http/errorResponse";
import { currentScope } from "@/server/runtime/scope";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const range = parseRange(req.headers.get("range"));
    if (range === "unsatisfiable") {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": "bytes */0" },
      });
    }
    const selected = await currentScope()
      .facades()
      .articles()
      .streamBundleSource(id, range ?? undefined);
    const size = selected.size;
    const length = rangeLength(range, size);
    const status = range ? 206 : 200;
    return new Response(selected.body, {
      status,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(length),
        "Accept-Ranges": "bytes",
        ...(range
          ? {
              "Content-Range": `bytes ${rangeStart(range, size)}-${rangeEnd(range, size)}/${size}`,
            }
          : {}),
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
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

/**
 * Parse a single bytes range without a known size. End-exclusive ranges and
 * suffix ranges are resolved by BlobStore against the opened file descriptor,
 * so the response body and Content-Length always describe the same bytes.
 */
function parseRange(
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

function rangeStart(range: BlobReadRange | null, size: number): number {
  if (!range) return 0;
  if (range.suffixLength !== undefined) {
    return Math.max(0, size - range.suffixLength);
  }
  return range.start ?? 0;
}

function rangeEnd(range: BlobReadRange | null, size: number): number {
  if (!range) return size - 1;
  if (range.suffixLength !== undefined) return size - 1;
  return Math.min(range.end ?? size - 1, size - 1);
}

function rangeLength(range: BlobReadRange | null, size: number): number {
  if (!range) return size;
  return rangeEnd(range, size) - rangeStart(range, size) + 1;
}
