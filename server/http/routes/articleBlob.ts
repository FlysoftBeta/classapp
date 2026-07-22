import { getDb } from "@/server/infra/db";
import { findArticleForUser } from "@/server/data/articles";
import { readArticleBlob } from "@/server/infra/articleBlobs";
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

    const body = await readArticleBlob(article.blob_path);
    const arrayBuffer = new ArrayBuffer(body.byteLength);
    new Uint8Array(arrayBuffer).set(body);
    return new Response(arrayBuffer, {
      headers: {
        "Content-Type": article.mime_type ?? "application/octet-stream",
        "Content-Length": String(body.byteLength),
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return handleServiceError(e);
  }
}
