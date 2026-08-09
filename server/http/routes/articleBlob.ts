import { getDb } from "@/server/infra/db";
import { findArticleForUser } from "@/server/data/articles";
import {
  articleBlobSize,
  streamArticleBlob,
} from "@/server/infra/articleBlobs";
import { handleServiceError, ServiceError } from "@/server/services/errors";
import { requireActiveAuth } from "@/server/domain/policy/auth";
import { assertCanAccessArticle } from "@/server/domain/policy/articles";
import { hasFeature } from "@/shared/features";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = requireActiveAuth(req);
  if ("error" in auth)
    return Response.json({ error: auth.error }, { status: auth.status });
  if (
    !hasFeature(auth.user, "articles") ||
    !hasFeature(auth.user, "ebook_reader")
  )
    return Response.json({ error: "无权限" }, { status: 403 });

  const { id } = await params;
  try {
    const db = getDb();
    assertCanAccessArticle(db, auth.user, id);
    const article = findArticleForUser(db, id, auth.user.id);
    if (!article || article.content_kind !== "blob" || !article.blob_path) {
      throw new ServiceError("二进制文章不存在", 404);
    }

    const size = await articleBlobSize(article.blob_path);
    const range = parseRange(req.headers.get("range"), size);
    if (range === "unsatisfiable") {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    }
    const selected = await streamArticleBlob(
      article.blob_path,
      range || undefined,
    );
    const length = range ? range.end - range.start + 1 : size;
    return new Response(selected.body, {
      status: range ? 206 : 200,
      headers: {
        "Content-Type": article.mime_type ?? "application/octet-stream",
        "Content-Length": String(length),
        "Accept-Ranges": "bytes",
        ...(range
          ? { "Content-Range": `bytes ${range.start}-${range.end}/${size}` }
          : {}),
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return handleServiceError(e);
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
