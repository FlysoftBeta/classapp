import path from "node:path";
import { handleHttpError } from "@/server/http/errorResponse";
import { currentScope } from "@/server/runtime/scope";

const MIME_TYPES: Record<string, string> = {
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".docm": "application/vnd.ms-word.document.macroEnabled.12",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".pptm": "application/vnd.ms-powerpoint.presentation.macroEnabled.12",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
  ".xlsb": "application/vnd.ms-excel.sheet.binary.macroEnabled.12",
};

function contentDisposition(filename: string): string {
  const fallback =
    filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "document";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { document, body } = await currentScope()
      .facades()
      .administration()
      .downloadTeachDocument(id);
    const arrayBuffer = new ArrayBuffer(body.byteLength);
    new Uint8Array(arrayBuffer).set(body);
    return new Response(arrayBuffer, {
      headers: {
        "Content-Type":
          MIME_TYPES[path.extname(document.name).toLowerCase()] ??
          "application/octet-stream",
        "Content-Length": String(body.byteLength),
        "Content-Disposition": contentDisposition(document.name),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return handleHttpError(error);
  }
}
