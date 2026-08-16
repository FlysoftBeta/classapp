import path from "node:path";
import type { Database } from "better-sqlite3";
import type { ObjectStore } from "@/server/storage/objectStore";
import { QuotaService } from "@/server/storage/quotaService";
import {
  TreeStore,
  type TreeSnapshot,
} from "@/server/storage/treeStore";
import {
  normalizeTreePath,
  objectRef,
} from "@/server/storage/paths";
import type { AiAttachment } from "@/shared/types/api";
import { PublicError } from "@/server/services/incidentService";

const MAX_STORE_BYTES = 10 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 12 * 1024 * 1024;
const MAX_FILES = 256;
const MAX_PATH_DEPTH = 3;

const TEXT_EXTENSIONS = new Set([".txt", ".md", ".svg"]);
const ATTACHMENT_EXTENSIONS = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
} as const;
const SUPPORTED_EXTENSIONS = new Set<string>([
  ...TEXT_EXTENSIONS,
  ...Object.values(ATTACHMENT_EXTENSIONS),
]);

const LIMITS = {
  maxBytes: MAX_STORE_BYTES,
  maxFiles: MAX_FILES,
  maxPathDepth: MAX_PATH_DEPTH,
  maxArchiveBytes: MAX_ARCHIVE_BYTES,
} as const;

interface WorkspaceFile {
  path: string;
  mime: string;
  size: number;
  updated_at: string;
}

function quotaGroup(userId: string): string {
  return `ai-workspaces:${userId}`;
}

function logicalTreePath(value: string): string {
  const normalized = normalizeTreePath(value);
  if (normalized.split("/").length > MAX_PATH_DEPTH) {
    throw new PublicError("文件路径无效；请使用不超过两级目录的相对路径");
  }
  if (normalized.split("/").some((part) => part.startsWith("."))) {
    throw new PublicError("文件路径无效；目录名和文件名不能以点开头");
  }
  const extension = path.posix.extname(normalized).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw new PublicError("文件类型不受支持");
  }
  return normalized;
}

function textLogicalPath(value: string): string {
  const normalized = logicalTreePath(value);
  if (normalized.startsWith("attachments/")) {
    throw new PublicError("文本工具不能修改附件目录");
  }
  if (!TEXT_EXTENSIONS.has(path.posix.extname(normalized).toLowerCase())) {
    throw new PublicError("只支持 txt、md 和 svg 文件");
  }
  return normalized;
}

function attachmentLogicalPath(value: string): string {
  const normalized = logicalTreePath(value);
  if (!normalized.startsWith("attachments/")) {
    throw new PublicError("图片附件路径无效");
  }
  return normalized;
}

function mimeFor(filePath: string): string {
  const extension = path.posix.extname(filePath).toLowerCase();
  if (extension === ".md") return "text/markdown";
  if (extension === ".svg") return "image/svg+xml";
  return "text/plain";
}

function assertSafeTextContent(filePath: string, content: string): void {
  if (content.includes("\0")) throw new PublicError("文件内容包含无效字符");
  if (path.posix.extname(filePath).toLowerCase() !== ".svg") return;
  if (
    /<\s*(?:script|foreignObject)\b/i.test(content) ||
    /\son[a-z]+\s*=/i.test(content) ||
    /(?:href|src)\s*=\s*["']\s*(?:javascript:|https?:|\/\/)/i.test(content) ||
    /<!ENTITY\b/i.test(content)
  ) {
    throw new PublicError("SVG 包含脚本、事件处理器或外部资源");
  }
}

function attachmentMagicMatches(
  mime: keyof typeof ATTACHMENT_EXTENSIONS,
  bytes: Uint8Array,
): boolean {
  const header = Buffer.from(bytes.subarray(0, 12));
  if (mime === "image/png")
    return header.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  if (mime === "image/jpeg")
    return header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  if (mime === "image/gif")
    return header.subarray(0, 4).toString("ascii") === "GIF8";
  return (
    header.subarray(0, 4).toString("ascii") === "RIFF" &&
    header.subarray(8, 12).toString("ascii") === "WEBP"
  );
}

function nextAttachmentPath(
  name: string,
  extension: string,
  existing: Set<string>,
): string {
  const base =
    path.posix
      .basename(name, path.posix.extname(name))
      .normalize("NFKC")
      .replace(/[^\p{L}\p{N}_-]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "image";
  let candidate = `attachments/${base}${extension}`;
  let suffix = 2;
  while (existing.has(candidate)) {
    candidate = `attachments/${base}-${suffix}${extension}`;
    suffix += 1;
  }
  return candidate;
}

function publicFile(entry: {
  path: string;
  mime: string;
  size: number;
  updatedAt: string;
}): WorkspaceFile {
  return {
    path: entry.path,
    mime: entry.mime,
    size: entry.size,
    updated_at: entry.updatedAt,
  };
}

/**
 * AI writing workspace: AI-specific path/content policy over the generic
 * manifest tree store. Storage stays generic; every rule in this file is a
 * product rule for the model's file tools and image attachments.
 */
export class AiWorkspace {
  private readonly ref = objectRef("ai-workspaces", this.userId);
  private readonly trees = new TreeStore(this.objects);
  private readonly quota = new QuotaService(this.db);

  constructor(
    private readonly db: Database,
    private readonly userId: string,
    private readonly objects: ObjectStore,
  ) {}

  async inspect() {
    const snapshot = await this.trees.inspect(this.ref, LIMITS);
    this.account(snapshot);
    return {
      revision: snapshot.revision,
      totalBytes: snapshot.totalBytes,
      files: snapshot.files.map(publicFile),
    };
  }

  async read(requestedPath: string) {
    const filePath = textLogicalPath(requestedPath);
    const snapshot = await this.trees.inspect(this.ref, LIMITS);
    const found = snapshot.read(filePath);
    if (!found) throw new PublicError("文件不存在");
    return {
      ...publicFile(found.entry),
      content: Buffer.from(found.bytes).toString("utf8"),
      revision: snapshot.revision,
    };
  }

  async mutate(
    mutation:
      | { kind: "create"; path: string; content: string }
      | {
          kind: "replace";
          path: string;
          oldText: string;
          newText: string;
          expectedReplacements: number;
        }
      | { kind: "delete"; path: string },
  ) {
    const filePath = textLogicalPath(mutation.path);
    let result: { file: WorkspaceFile | null; deleted: string | null };
    const snapshot = await this.trees.mutate(this.ref, LIMITS, (tree) => {
      const existing = tree.has(filePath);
      let file: WorkspaceFile | null = null;
      let deleted: string | null = null;
      if (mutation.kind === "create") {
        if (existing) throw new PublicError("文件已存在，请使用局部修改工具");
        const content = mutation.content;
        assertSafeTextContent(filePath, content);
        file = publicFile(
          tree.put(filePath, Buffer.from(content, "utf8"), mimeFor(filePath), new Date().toISOString()),
        );
      } else if (mutation.kind === "delete") {
        if (!existing) throw new PublicError("文件不存在");
        tree.delete(filePath);
        deleted = filePath;
      } else {
        const found = tree.get(filePath);
        if (!found) throw new PublicError("文件不存在");
        const previous = Buffer.from(found.bytes).toString("utf8");
        if (!mutation.oldText) throw new PublicError("oldText 不能为空");
        const occurrences = previous.split(mutation.oldText).length - 1;
        if (occurrences !== mutation.expectedReplacements) {
          throw new PublicError(
            `待替换文本出现 ${occurrences} 次，与期望的 ${mutation.expectedReplacements} 次不一致`,
          );
        }
        const content = previous
          .split(mutation.oldText)
          .join(mutation.newText);
        assertSafeTextContent(filePath, content);
        file = publicFile(
          tree.put(filePath, Buffer.from(content, "utf8"), mimeFor(filePath), new Date().toISOString()),
        );
      }
      result = { file, deleted };
    });
    this.account(snapshot);
    return {
      revision: snapshot.revision,
      totalBytes: snapshot.totalBytes,
      file: result!.file,
      deleted: result!.deleted,
    };
  }

  async storeAttachments(
    inputs: Array<{
      name: string;
      mime: keyof typeof ATTACHMENT_EXTENSIONS;
      bytes: Uint8Array;
    }>,
  ): Promise<AiAttachment[]> {
    const attachments: AiAttachment[] = [];
    const snapshot = await this.trees.mutate(this.ref, LIMITS, (tree) => {
      const existing = new Set(tree.files.map((file) => file.path));
      for (const input of inputs) {
        if (!input.bytes.byteLength) throw new PublicError("图片内容为空");
        if (!attachmentMagicMatches(input.mime, input.bytes)) {
          throw new PublicError(`${input.name} 的图片格式与声明类型不一致`);
        }
        const attachmentPath = nextAttachmentPath(
          input.name,
          ATTACHMENT_EXTENSIONS[input.mime],
          existing,
        );
        existing.add(attachmentPath);
        tree.put(
          attachmentPath,
          input.bytes,
          input.mime,
          new Date().toISOString(),
        );
        attachments.push({
          path: attachmentPath,
          name: input.name.slice(0, 200),
          mime: input.mime,
          size: input.bytes.byteLength,
        });
      }
    });
    this.account(snapshot);
    return attachments;
  }

  async readAttachmentDataUrl(attachment: AiAttachment): Promise<string> {
    const requestedPath = attachmentLogicalPath(attachment.path);
    const snapshot = await this.trees.inspect(this.ref, LIMITS);
    const found = snapshot.read(requestedPath);
    if (!found || found.entry.mime !== attachment.mime) {
      throw new PublicError("图片附件不存在");
    }
    return `data:${found.entry.mime};base64,${Buffer.from(found.bytes).toString("base64")}`;
  }

  async deleteAttachments(requestedPaths: string[]): Promise<void> {
    if (!requestedPaths.length) return;
    const paths = new Set(requestedPaths.map(attachmentLogicalPath));
    const before = await this.trees.inspect(this.ref, LIMITS);
    if (!before.files.some((file) => paths.has(file.path))) return;
    const snapshot = await this.trees.mutate(this.ref, LIMITS, (tree) => {
      for (const filePath of paths) tree.delete(filePath);
    });
    this.account(snapshot);
  }

  async remove(): Promise<void> {
    await this.trees.remove(this.ref);
    this.quota.remove(quotaGroup(this.userId), this.userId);
    this.quota.removeGroup(quotaGroup(this.userId));
  }

  private account(snapshot: TreeSnapshot): void {
    this.quota.configure({
      name: quotaGroup(this.userId),
      maxBytes: MAX_STORE_BYTES,
      targetRatio: 0.8,
      minAgeMs: 0,
    });
    this.quota.upsert(quotaGroup(this.userId), this.userId, snapshot.totalBytes);
  }
}
