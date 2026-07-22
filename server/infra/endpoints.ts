import { PORTS } from "./env";

export function originFromParts(
  protocol: string,
  hostname: string,
  port: number,
): string {
  const defaultPort = protocol === "https:" ? 443 : 80;
  if (port === defaultPort) return `${protocol}//${hostname}`;
  return `${protocol}//${hostname}:${port}`;
}

export function requestProtocol(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-proto");
  if (forwarded) {
    const proto = forwarded.split(",")[0]?.trim();
    if (proto) return `${proto}:`;
  }
  return new URL(req.url).protocol;
}

export function requestHostname(req: Request): string {
  const host = req.headers.get("host");
  if (host) return host.split(":")[0];
  return new URL(req.url).hostname;
}

export function originsForRequest(req: Request): string[] {
  const protocol = requestProtocol(req);
  const hostname = requestHostname(req);
  return PORTS.map((port) => originFromParts(protocol, hostname, port));
}
