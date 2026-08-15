import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RuntimeConfig } from "@/server/infra/runtimeConfig";
import { GET as endpoints } from "@/server/http/routes/endpoints";
import { POST as uploadArticle } from "@/server/http/routes/articleUpload";
import { GET as articleSource } from "@/server/http/routes/articleSource";
import { POST as articleBundleResources } from "@/server/http/routes/articleBundleResources";
import { POST as deploy } from "@/server/http/routes/deploy";
import { GET as downloadBackup } from "@/server/http/routes/backupDownload";
import { GET as downloadTeachDocument } from "@/server/http/routes/teachDocumentDownload";
import { GET as downloadIncidentLogs } from "@/server/http/routes/incidentLogsDownload";
import { renderServiceWorker } from "@/server/http/serviceWorker";
import { handleHttpError } from "@/server/http/errorResponse";
import {
  createRuntimeManifest,
  runtimeAssets,
} from "@/server/infra/runtimeAssets";
import type { Runtime } from "@/server/runtime/runtime";
import { currentScope, withScope } from "@/server/runtime/scope";
import { identifyClientRequest } from "@/server/infra/clientIdentity";
import { findSessionIdentityByToken } from "@/server/data/auth";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
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
  config: RuntimeConfig,
  runtime: Runtime,
  options: { secure?: boolean } = {},
) {
  const secure = options.secure === true;
  const publicRoot = path.join(config.appDir, "public");
  const { shellFile, bundleFile } = runtimeAssets(config.appDir);

  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const authorization = req.headers.authorization;
    const bearer = authorization?.startsWith("Bearer ")
      ? authorization.slice(7).trim()
      : null;
    const token = bearer || url.searchParams.get("token");
    const session = token
      ? findSessionIdentityByToken(runtime.db, token)
      : null;
    const identity = identifyClientRequest(req);
    return withScope(
      runtime.scope({
        token: session ? token : null,
        userId: session?.userId ?? null,
        clientId: session?.clientId ?? null,
        ...identity,
      }),
      async () => {
        try {
          const origin = req.headers.origin;
          if (origin) {
            try {
              if (
                new URL(origin).hostname ===
                (req.headers.host ?? "").split(":")[0]
              ) {
                res.setHeader("Access-Control-Allow-Origin", origin);
                res.setHeader(
                  "Access-Control-Allow-Headers",
                  "authorization, content-type",
                );
                res.setHeader(
                  "Access-Control-Allow-Methods",
                  "GET, POST, OPTIONS",
                );
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
            config.https &&
            config.securePorts.length > 0 &&
            currentScope().facades().app().httpsRedirectEnabled()
          ) {
            const securePort = config.securePorts[0];
            const port = securePort === 443 ? "" : `:${securePort}`;
            res.statusCode = 301;
            res.setHeader(
              "Location",
              `https://${config.https.domain}${port}/${url.search}`,
            );
            res.setHeader(
              "Cache-Control",
              "public, max-age=315360000, immutable",
            );
            res.setHeader("Content-Length", "0");
            res.end();
            return;
          }
          if (url.pathname === "/") {
            if (sendFile(shellFile, res, "no-store, max-age=0")) return;
          }
          if (url.pathname === "/service-worker.js") {
            const body = renderServiceWorker();
            res.statusCode = 200;
            res.setHeader("Content-Type", "text/javascript; charset=utf-8");
            res.setHeader("Service-Worker-Allowed", "/");
            res.setHeader(
              "Cache-Control",
              "no-cache, max-age=0, must-revalidate",
            );
            res.setHeader("Content-Length", Buffer.byteLength(body));
            res.end(body);
            return;
          }
          if (url.pathname === "/manifest.webmanifest") {
            if (
              sendFile(
                path.join(publicRoot, "manifest.webmanifest"),
                res,
                "no-cache, max-age=0, must-revalidate",
              )
            )
              return;
          }
          // Latest bundle
          if (url.pathname === "/app/manifest.json") {
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.setHeader("Cache-Control", "no-store");
            res.end(JSON.stringify(createRuntimeManifest(config)));
            return;
          }
          // Request with ?v=version
          if (url.pathname === "/app/app.js") {
            if (
              sendFile(bundleFile, res, "public, max-age=31536000, immutable")
            )
              return;
          }
          if (url.pathname === "/app/shell.html") {
            if (sendFile(shellFile, res, "public, max-age=31536000, immutable"))
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
          const sourceMatch = url.pathname.match(
            /^\/api\/articles\/([^/]+)\/source$/,
          );
          if (req.method === "GET" && sourceMatch) {
            await sendResponse(
              await articleSource(request(), {
                params: Promise.resolve({
                  id: decodeURIComponent(sourceMatch[1]),
                }),
              }),
              res,
            );
            return;
          }
          const bundleResourceMatch = url.pathname.match(
            /^\/api\/articles\/([^/]+)\/bundle\/resources$/,
          );
          if (req.method === "POST" && bundleResourceMatch) {
            await sendResponse(
              await articleBundleResources(request(), {
                params: Promise.resolve({
                  id: decodeURIComponent(bundleResourceMatch[1]),
                }),
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
          if (
            req.method === "GET" &&
            url.pathname === "/api/admin/incidents/logs"
          ) {
            await sendResponse(await downloadIncidentLogs(), res);
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
          const response = handleHttpError(error);
          if (!res.headersSent) {
            await sendResponse(response, res);
          } else {
            res.end();
          }
        }
      },
    );
  };
}
