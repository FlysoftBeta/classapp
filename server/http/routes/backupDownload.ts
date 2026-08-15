import { handleHttpError } from "@/server/http/errorResponse";
import { currentScope } from "@/server/runtime/scope";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  try {
    const { name } = await params;
    const { zipName, zipData } = currentScope()
      .facades()
      .administration()
      .downloadBackup(name);

    return new Response(zipData.slice(), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${zipName}"`,
        "Content-Length": String(zipData.byteLength),
      },
    });
  } catch (e) {
    return handleHttpError(e);
  }
}
