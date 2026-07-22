import { getDb } from "@/server/infra/db";
import { findArticleForUser } from "@/server/data/articles";
import { handleServiceError, ServiceError } from "@/server/services/errors";
import { renderArticlePage } from "@/server/services/pdfRenderer";
import { requireActiveAuth } from "@/server/domain/policy/auth";
import { assertCanAccessArticle } from "@/server/domain/policy/articles";
import { hasFeature } from "@/shared/features";

function clampInt(
  value: string | null,
  fallback: number,
  min: number,
  max: number,
) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

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
  const p = new URL(req.url).searchParams;
  const page = clampInt(p.get("page"), 0, 0, 5000);
  const width = clampInt(p.get("width"), 900, 320, 6000);
  const height = clampInt(p.get("height"), 1200, 320, 6000);

  try {
    const db = getDb();
    assertCanAccessArticle(db, auth.user, id);
    const article = findArticleForUser(db, id, auth.user.id);
    if (
      !article ||
      article.content_kind !== "blob" ||
      article.mime_type !== "application/pdf" ||
      !article.blob_path
    ) {
      throw new ServiceError("PDF 文章不存在", 404);
    }

    const { body, numPages } = await renderArticlePage({
      articleId: id,
      blobPath: article.blob_path,
      page,
      width,
      height,
    });

    const arrayBuffer = new ArrayBuffer(body.byteLength);
    new Uint8Array(arrayBuffer).set(body);
    if (body.byteLength === 0) {
      throw new ServiceError("渲染结果为空", 500);
    }

    return new Response(arrayBuffer, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "no-store",
        "Content-Length": String(body.byteLength),
        "X-PDF-Num-Pages": String(numPages),
      },
    });
  } catch (e) {
    return handleServiceError(e);
  }
}
