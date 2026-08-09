import { Readable } from "node:stream";
import { getDb } from "@/server/infra/db";
import { findArticleRecord } from "@/server/data/articles";
import {
  loadRenderArchive,
  streamArchiveResource,
} from "@/server/infra/renderArchive";
import { handleServiceError, ServiceError } from "@/server/services/errors";
import { requireActiveAuth } from "@/server/domain/policy/auth";
import { assertCanAccessArticle } from "@/server/domain/policy/articles";
import { hasFeature } from "@/shared/features";
import {
  BUNDLE_STREAM_MAGIC,
  BUNDLE_STREAM_VERSION,
  bundleResourceRequestSchema,
} from "@/shared/bundles/protocol";

const MAX_BATCH_BYTES = 513 * 1024 * 1024;

function framingHeader(count: number): Buffer {
  const header = Buffer.allocUnsafe(12);
  header.write(BUNDLE_STREAM_MAGIC, 0, 8, "ascii");
  header.writeUInt16LE(BUNDLE_STREAM_VERSION, 8);
  header.writeUInt16LE(count, 10);
  return header;
}

function resourceHeader(contentId: string, size: number): Buffer {
  const header = Buffer.allocUnsafe(36);
  Buffer.from(contentId, "hex").copy(header, 0);
  header.writeUInt32LE(size, 32);
  return header;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = requireActiveAuth(req);
  if ("error" in auth)
    return Response.json({ error: auth.error }, { status: auth.status });
  if (
    !hasFeature(auth.user, "articles") ||
    !hasFeature(auth.user, "ebook_reader")
  ) {
    return Response.json({ error: "无权限" }, { status: 403 });
  }

  try {
    const { id } = await params;
    const parsed = bundleResourceRequestSchema.safeParse(await req.json());
    if (!parsed.success) throw new ServiceError("资源请求无效", 400);
    if (
      new Set(parsed.data.content_ids).size !== parsed.data.content_ids.length
    ) {
      throw new ServiceError("资源请求包含重复项", 400);
    }
    const db = getDb();
    assertCanAccessArticle(db, auth.user, id);
    const article = findArticleRecord(db, id);
    if (
      !article ||
      article.content_kind !== "bundle" ||
      !article.archive_path
    ) {
      throw new ServiceError("文档资源不存在", 404);
    }
    const archive = await loadRenderArchive(article.archive_path);
    const resources = parsed.data.content_ids.map((contentId) => {
      const resource = archive.resources.get(contentId);
      if (!resource) throw new ServiceError("文档资源不存在", 404);
      return resource;
    });
    const payloadBytes = resources.reduce(
      (sum, resource) => sum + 36 + resource.stored_size,
      12,
    );
    if (!Number.isSafeInteger(payloadBytes) || payloadBytes > MAX_BATCH_BYTES) {
      throw new ServiceError("单次资源请求过大，请缩小批次", 413);
    }

    async function* stream() {
      yield framingHeader(resources.length);
      for (const resource of resources) {
        yield resourceHeader(resource.content_id, resource.stored_size);
        if (!resource.stored_size) continue;
        // Open range streams lazily so large batches do not accumulate file
        // descriptors while earlier resources are still being transferred.
        const source = Readable.fromWeb(
          streamArchiveResource(archive, resource) as never,
        );
        for await (const chunk of source) yield chunk as Buffer;
      }
    }

    return new Response(
      Readable.toWeb(Readable.from(stream())) as ReadableStream<Uint8Array>,
      {
        headers: {
          "Content-Type": "application/vnd.classapp.bundle-stream",
          "Content-Length": String(payloadBytes),
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    return handleServiceError(error);
  }
}
