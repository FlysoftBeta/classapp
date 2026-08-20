import { handleHttpError } from "@/server/http/errorResponse";
import { currentScope } from "@/server/runtime/scope";
import { MAX_POST_IMAGE_BYTES } from "@/server/services/postImagesService";

const MAX_MULTIPART_OVERHEAD_BYTES = 1024 * 1024;

export async function POST(req: Request) {
  try {
    const contentType = req.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      return Response.json({ error: "请使用 multipart/form-data 上传图片" }, {
        status: 400,
      });
    }
    const declared = Number(req.headers.get("content-length"));
    if (
      Number.isFinite(declared) &&
      declared > MAX_POST_IMAGE_BYTES + MAX_MULTIPART_OVERHEAD_BYTES
    ) {
      return Response.json({ error: "图片不能超过 12 MB" }, { status: 413 });
    }

    const form = await req.formData();
    const file = form.get("file");
    const convId = String(form.get("conv_id") ?? "").trim();
    const replyTo = String(form.get("reply_to") ?? "").trim();
    if (!(file instanceof File)) {
      return Response.json({ error: "必须上传图片文件" }, { status: 400 });
    }
    if (!convId) {
      return Response.json({ error: "必须指定会话" }, { status: 400 });
    }

    const posts = currentScope().facades().posts();
    const result = await posts.createImage({
      file,
      conv_id: convId,
      reply_to: replyTo || null,
    });
    return Response.json(result, { status: 201 });
  } catch (error) {
    return handleHttpError(error);
  }
}
