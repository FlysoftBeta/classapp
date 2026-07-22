import { getDb } from "@/server/infra/db";
import { createArticleService } from "@/server/services/articlesService";
import {
  removeArticleBlob,
  storeArticleBlob,
} from "@/server/infra/articleBlobs";
import { handleServiceError } from "@/server/services/errors";
import { requireActiveAuth } from "@/server/domain/policy/auth";
import { hasFeature } from "@/shared/features";

export async function POST(req: Request) {
  const auth = requireActiveAuth(req);
  if ("error" in auth)
    return Response.json({ error: auth.error }, { status: auth.status });
  if (
    !hasFeature(auth.user, "articles") ||
    !hasFeature(auth.user, "ebook_reader")
  )
    return Response.json({ error: "无权限" }, { status: 403 });

  try {
    const contentType = req.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      return Response.json(
        {
          error:
            "Deprecated JSON article creation route. Use a OneShot Action for text articles and multipart/form-data only for blob uploads.",
        },
        { status: 410 },
      );
    }

    const form = await req.formData();
    const file = form.get("file");
    const title = String(form.get("title") ?? "");
    if (!(file instanceof File)) {
      return Response.json({ error: "必须上传 PDF 文件" }, { status: 400 });
    }

    const stored = await storeArticleBlob(file);
    try {
      const articles = createArticleService(getDb());
      const result = articles.createBlob(auth.user, {
        title: title || stored.originalFilename.replace(/\.pdf$/i, ""),
        blob_path: stored.relativePath,
        mime_type: stored.mimeType,
        file_size: stored.fileSize,
        original_filename: stored.originalFilename,
      });
      return Response.json({ article: result.article }, { status: 201 });
    } catch (e) {
      await removeArticleBlob(stored.relativePath).catch(() => {});
      throw e;
    }
  } catch (e) {
    return handleServiceError(e);
  }
}
