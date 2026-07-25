import fs from "node:fs";
import { execFileSync } from "node:child_process";
import type { IncomingMessage } from "node:http";
import { networkInterfaces } from "node:os";
import { getRuntimeConfig } from "@/server/infra/runtimeConfig";

export interface ClientIdentity {
  ip: string;
  userAgent: string;
  mac: string | null;
}

function normalizeMac(value: string): string | null {
  const match = value.match(/\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/i);
  if (!match) return null;
  const mac = match[0].replace(/-/g, ":").toLowerCase();
  return mac === "00:00:00:00:00:00" ? null : mac;
}

function normalizeIp(value: string): string {
  return value
    .replace(/^::ffff:/i, "")
    .replace(/%.+$/, "")
    .toLowerCase();
}

function requestIp(req: IncomingMessage): string {
  const peer = normalizeIp(req.socket.remoteAddress ?? "127.0.0.1");
  const trustedProxies = new Set(
    getRuntimeConfig().trustedProxyIps.map(normalizeIp),
  );
  if (!trustedProxies.has(peer)) return peer;

  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    // Each proxy appends its direct peer, so the rightmost untrusted address
    // is the original client rather than an address it may have prepended.
    for (const value of forwarded.split(",").reverse()) {
      const ip = normalizeIp(value.trim());
      if (ip && !trustedProxies.has(ip)) return ip;
    }
  }
  return peer;
}

function resolveLocalMac(ip: string): { local: boolean; mac: string | null } {
  const target = normalizeIp(ip);
  try {
    for (const addresses of Object.values(networkInterfaces())) {
      for (const address of addresses ?? []) {
        if (normalizeIp(address.address) === target) {
          return { local: true, mac: normalizeMac(address.mac) };
        }
      }
    }
  } catch {
    /* Fall through to the platform neighbour lookup. */
  }
  return { local: false, mac: null };
}

/** Best-effort LAN neighbour lookup. Browsers cannot expose a device MAC. */
function resolveMac(ip: string): string | null {
  const local = resolveLocalMac(ip);
  if (local.local) return local.mac;

  try {
    const rows = fs.readFileSync("/proc/net/arp", "utf8").split("\n");
    const row = rows.find((line) => line.trim().split(/\s+/)[0] === ip);
    if (row) return normalizeMac(row);
  } catch {
    /* non-Linux host */
  }
  try {
    return normalizeMac(
      execFileSync("arp", ["-a", ip], {
        encoding: "utf8",
        timeout: 1000,
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch {
    return null;
  }
}

export function identifyClientRequest(req: IncomingMessage): ClientIdentity {
  const ip = requestIp(req);
  return {
    ip,
    userAgent: String(req.headers["user-agent"] ?? "").slice(0, 1000),
    mac: resolveMac(ip),
  };
}
