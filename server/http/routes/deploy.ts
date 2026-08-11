import { getDb } from "@/server/infra/db";
import { requireActiveAdmin } from "@/server/domain/policy/auth";
import { PublicError, handleHttpError } from "@/server/http/errorResponse";
import { createAdminSystemService } from "@/server/services/adminSystemService";

export async function POST(req: Request) {
  const auth = requireActiveAdmin(req);
  if ("error" in auth)
    return Response.json({ error: auth.error }, { status: auth.status });

  try {
    const formData = await req.formData().catch(() => null);
    if (!formData)
      throw new PublicError("请求格式错误，需要 multipart/form-data");

    const file = formData.get("file") as File | null;
    if (!file) throw new PublicError("缺少 file 字段");

    const zipBytes = new Uint8Array(await file.arrayBuffer());
    const system = createAdminSystemService(getDb());
    const result = await system.deployPackage(zipBytes);

    return Response.json(result, { status: 202 });
  } catch (e) {
    return handleHttpError(e);
  }
}
