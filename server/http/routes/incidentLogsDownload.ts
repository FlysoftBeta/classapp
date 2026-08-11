import { requireActiveAdmin } from "@/server/domain/policy/auth";
import { getDb } from "@/server/infra/db";
import { BUILD_ID } from "@/server/infra/env";
import { handleHttpError } from "@/server/http/errorResponse";
import { buildIncidentLogArchive } from "@/server/services/incidentLogArchiveService";

export async function GET(req: Request) {
  const auth = requireActiveAdmin(req, { allowQueryToken: true });
  if ("error" in auth)
    return Response.json({ error: auth.error }, { status: auth.status });

  try {
    const { zipName, zipData } = buildIncidentLogArchive(getDb(), BUILD_ID);
    return new Response(zipData.slice(), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${zipName}"`,
        "Content-Length": String(zipData.byteLength),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return handleHttpError(error);
  }
}
