import { PublicError, handleHttpError } from "@/server/http/errorResponse";
import { currentScope } from "@/server/runtime/scope";

export async function POST(req: Request) {
  try {
    const formData = await req.formData().catch(() => null);
    if (!formData)
      throw new PublicError("请求格式错误，需要 multipart/form-data");

    const file = formData.get("file") as File | null;
    if (!file) throw new PublicError("缺少 file 字段");

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
