import { PublicError, handleHttpError } from "@/server/http/errorResponse";
import { currentScope } from "@/server/runtime/scope";

/** Bounded before buffering: deployment archives are normally far smaller. */
const MAX_DEPLOY_UPLOAD_BYTES = 512 * 1024 * 1024;

export async function POST(req: Request) {
  try {
    const declared = Number(req.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_DEPLOY_UPLOAD_BYTES) {
      return Response.json({ error: "部署包不能超过 512 MB" }, { status: 413 });
    }
    const formData = await req.formData().catch(() => null);
    if (!formData)
      throw new PublicError("请求格式错误，需要 multipart/form-data");

    const file = formData.get("file") as File | null;
    if (!file) throw new PublicError("缺少 file 字段");
    if (file.size > MAX_DEPLOY_UPLOAD_BYTES) {
      return Response.json({ error: "部署包不能超过 512 MB" }, { status: 413 });
    }

    const zipBytes = new Uint8Array(await file.arrayBuffer());
    const result = await currentScope()
      .facades()
      .administration()
      .deployPackage(zipBytes);

    return Response.json(result, { status: 202 });
  } catch (e) {
    return handleHttpError(e);
  }
}
