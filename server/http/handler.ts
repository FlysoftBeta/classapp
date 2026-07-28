import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ClassAppRuntimeConfig } from "@/server/infra/runtimeConfig";
import { GET as endpoints } from "@/server/http/routes/endpoints";
import { POST as uploadArticle } from "@/server/http/routes/articleUpload";
import { GET as articleBlob } from "@/server/http/routes/articleBlob";
import { GET as renderArticle } from "@/server/http/routes/articleRender";
import { POST as deploy } from "@/server/http/routes/deploy";
import { GET as downloadBackup } from "@/server/http/routes/backupDownload";
import { GET as downloadTeachDocument } from "@/server/http/routes/teachDocumentDownload";
import { renderServiceWorker } from "@/server/http/serviceWorker";
import { getDb } from "@/server/infra/db";
import { createHttpsUpgradeService } from "@/server/services/httpsUpgradeService";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
};

function absoluteUrl(req: IncomingMessage, secure: boolean): string {
  const protocol =
    req.headers["x-forwarded-proto"]?.toString().split(",")[0] ??
    (secure ? "https" : "http");
  return `${protocol}://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
}

function toRequest(req: IncomingMessage, secure: boolean): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value))
      for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(absoluteUrl(req, secure), {
    method: req.method,
    headers,
    ...(hasBody
      ? { body: Readable.toWeb(req) as ReadableStream, duplex: "half" as const }
      : {}),
  });
}

async function sendResponse(
  response: Response,
  res: ServerResponse,
): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => res.setHeader(name, value));
  if (!response.body) {
    res.end();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    Readable.fromWeb(response.body as never)
      .on("error", reject)
      .on("end", resolve)
      .pipe(res);
  });
}

function sendFile(
  file: string,
  res: ServerResponse,
  cacheControl: string,
): boolean {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  res.statusCode = 200;
  res.setHeader(
    "Content-Type",
    TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
  );
  res.setHeader("Content-Length", fs.statSync(file).size);
  res.setHeader("Cache-Control", cacheControl);
  fs.createReadStream(file).pipe(res);
  return true;
}

function safePublicPath(root: string, pathname: string): string | null {
  const candidate = path.resolve(root, `.${decodeURIComponent(pathname)}`);
  return candidate.startsWith(`${path.resolve(root)}${path.sep}`)
    ? candidate
    : null;
}

export function createHttpHandler(
  config: ClassAppRuntimeConfig,
  options: { secure?: boolean } = {},
) {
  const secure = options.secure === true;
  const clientRoot = path.join(config.appDir, "client");
  const publicRoot = path.join(config.appDir, "public");
  const shellFile = path.join(config.appDir, "shell.html");
  const bundleFile = path.join(clientRoot, "app", "app.js");

  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const origin = req.headers.origin;
      if (origin) {
        try {
          if (
            new URL(origin).hostname === (req.headers.host ?? "").split(":")[0]
          ) {
            res.setHeader("Access-Control-Allow-Origin", origin);
            res.setHeader(
              "Access-Control-Allow-Headers",
              "authorization, content-type",
            );
            res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
            res.setHeader("Vary", "Origin");
          }
        } catch {
          /* malformed Origin */
        }
      }
      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        res.end();
        return;
      }
      if (
        !secure &&
        (req.method === "GET" || req.method === "HEAD") &&
        url.pathname === "/" &&
        config.https.domain &&
        config.securePorts.length > 0 &&
        createHttpsUpgradeService(getDb()).isRedirectEnabled()
      ) {
        const securePort = config.securePorts[0];
        const port = securePort === 443 ? "" : `:${securePort}`;
        res.statusCode = 301;
        res.setHeader(
          "Location",
          `https://${config.https.domain}${port}/${url.search}`,
        );
        res.setHeader("Cache-Control", "public, max-age=315360000, immutable");
        res.setHeader("Content-Length", "0");
        res.end();
        return;
      }
      if (url.pathname === "/") {
        if (sendFile(shellFile, res, "no-store, max-age=0")) return;
      }
      if (url.pathname === "/service-worker.js") {
        const body = renderServiceWorker(config.buildId);
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/javascript; charset=utf-8");
        res.setHeader("Service-Worker-Allowed", "/");
        res.setHeader("Cache-Control", "no-cache, max-age=0, must-revalidate");
        res.setHeader("Content-Length", Buffer.byteLength(body));
        res.end(body);
        return;
      }
      if (url.pathname === "/app/manifest.json") {
        const size = fs.existsSync(bundleFile)
          ? fs.statSync(bundleFile).size
          : 0;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end(
          JSON.stringify({
            buildId: config.buildId,
            bundle: `/app/app.js?v=${encodeURIComponent(config.buildId)}`,
            size,
          }),
        );
        return;
      }
      if (url.pathname === "/app/app.js") {
        if (sendFile(bundleFile, res, "public, max-age=31536000, immutable"))
          return;
      }

      const request = () => toRequest(req, secure);
      if (req.method === "GET" && url.pathname === "/api/endpoints") {
        await sendResponse(await endpoints(request()), res);
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/articles") {
        await sendResponse(await uploadArticle(request()), res);
        return;
      }
      const blobMatch = url.pathname.match(/^\/api\/articles\/([^/]+)\/blob$/);
      if (req.method === "GET" && blobMatch) {
        await sendResponse(
          await articleBlob(request(), {
            params: Promise.resolve({ id: decodeURIComponent(blobMatch[1]) }),
          }),
          res,
        );
        return;
      }
      const renderMatch = url.pathname.match(
        /^\/api\/articles\/([^/]+)\/render$/,
      );
      if (req.method === "GET" && renderMatch) {
        await sendResponse(
          await renderArticle(request(), {
            params: Promise.resolve({ id: decodeURIComponent(renderMatch[1]) }),
          }),
          res,
        );
        return;
      }
      if (
        req.method === "POST" &&
        url.pathname === "/api/admin/system/deploy"
      ) {
        await sendResponse(await deploy(request()), res);
        return;
      }
      const backupMatch = url.pathname.match(
        /^\/api\/admin\/system\/backups\/([^/]+)$/,
      );
      if (req.method === "GET" && backupMatch) {
        await sendResponse(
          await downloadBackup(request(), {
            params: Promise.resolve({
              name: decodeURIComponent(backupMatch[1]),
            }),
          }),
          res,
        );
        return;
      }
      const teachDocumentMatch = url.pathname.match(
        /^\/api\/admin\/teach-documents\/([^/]+)\/download$/,
      );
      if (req.method === "GET" && teachDocumentMatch) {
        await sendResponse(
          await downloadTeachDocument(request(), {
            params: Promise.resolve({
              id: decodeURIComponent(teachDocumentMatch[1]),
            }),
          }),
          res,
        );
        return;
      }

      const publicFile = safePublicPath(publicRoot, url.pathname);
      if (
        publicFile &&
        sendFile(publicFile, res, "public, max-age=31536000, immutable")
      )
        return;
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (error) {
      console.error("HTTP request failed", error);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
      }
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  };
}
