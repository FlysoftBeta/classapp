import { handleHttpError } from "@/server/http/errorResponse";
import { currentScope } from "@/server/runtime/scope";

export async function GET() {
  try {
    const { zipName, zipData } = currentScope()
      .facades()
      .incidents()
      .downloadLogs();
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
