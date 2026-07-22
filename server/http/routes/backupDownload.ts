import { requireActiveAdmin } from "@/server/domain/policy/auth";
import { buildBackupDownload } from "@/server/infra/dbBackup";
import { handleServiceError } from "@/server/services/errors";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const auth = requireActiveAdmin(req, { allowQueryToken: true });
  if ("error" in auth)
    return Response.json({ error: auth.error }, { status: auth.status });

  try {
    const { name } = await params;
    const { zipName, zipData } = buildBackupDownload(name);

    return new Response(zipData.slice(), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${zipName}"`,
        "Content-Length": String(zipData.byteLength),
      },
    });
  } catch (e) {
    return handleServiceError(e);
  }
}
