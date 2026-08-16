import { handleHttpError } from "@/server/http/errorResponse";
import { currentScope } from "@/server/runtime/scope";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const selected = await currentScope()
      .facades()
      .articles()
      .streamBundleSource(id);
    const size = selected.size;
    const range = parseRange(req.headers.get("range"), size);
    if (range === "unsatisfiable") {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    }
    const length = range ? range.end - range.start + 1 : size;
    return new Response(selected.body, {
      status: range ? 206 : 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(length),
        "Accept-Ranges": "bytes",
        ...(range
          ? {
              "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
            }
          : {}),
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    return handleHttpError(error);
  }
}

function parseRange(
  value: string | null,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return "unsatisfiable";
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  ) {
    return "unsatisfiable";
  }
  return { start, end: Math.min(end, size - 1) };
}
