import {
  removeArticleBundle,
  storeArticleBundle,
} from "@/server/infra/articleArtifacts";
import { handleHttpError } from "@/server/http/errorResponse";
import { attachSuppressedError } from "@/server/services/incidentService";
import { currentScope } from "@/server/runtime/scope";

export async function POST(req: Request) {
  try {
    const contentType = req.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      return Response.json(
        {
          error:
            "Use a OneShot Action for text articles and multipart/form-data for document uploads.",
        },
        { status: 410 },
      );
    }

    const form = await req.formData();
    const file = form.get("file");
    const title = String(form.get("title") ?? "");
    const groupId = String(form.get("group_id") ?? "").trim();
    if (!(file instanceof File)) {
      return Response.json({ error: "必须上传 PDF 文件" }, { status: 400 });
    }
    if (!groupId) {
      return Response.json({ error: "文章必须归属群聊" }, { status: 400 });
    }

    // Reject an inaccessible target before consuming a bounded render slot.
    await currentScope().facades().articles().authorizeBundleUpload(groupId);
    const stored = await storeArticleBundle(file);
    try {
      const result = await currentScope()
        .facades()
        .articles()
        .createBundle({
          title: title || stored.originalFilename.replace(/\.pdf$/i, ""),
          source_path: stored.sourcePath,
          archive_path: stored.archivePath,
          source_mime: stored.sourceMime,
          source_size: stored.sourceSize,
          archive_size: stored.archiveSize,
          original_filename: stored.originalFilename,
          item_count: stored.itemCount,
          group_id: groupId,
        });
      return Response.json(result, { status: 201 });
    } catch (e) {
      try {
        await removeArticleBundle(stored.sourcePath, stored.archivePath);
      } catch (cleanupError) {
        attachSuppressedError(e, cleanupError);
      }
      throw e;
    }
  } catch (e) {
    return handleHttpError(e);
  }
}
