import crypto from "crypto";
import { getDb, getPinSecret } from "./db";
import type { User } from "@/shared/types/api";
import {
  deleteExpiredSessions,
  findUserBySessionToken,
} from "@/server/data/auth";
import { hasFeature } from "@/shared/features";

// ── Crypto / token utilities ──────────────────────────────────────────────────

export function hashPin(pin: string): string {
  const db = getDb();
  const secret = getPinSecret(db);
  return crypto.createHmac("sha256", secret).update(pin).digest("hex");
}

export function generateToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

// ── HTTP request utilities ────────────────────────────────────────────────────

export function getIP(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  return "127.0.0.1";
}

export function getBearerToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) return null;
  return auth.slice(7).trim();
}

// ── Session middleware ────────────────────────────────────────────────────────

export function getUserFromToken(token: string): User | null {
  const db = getDb();
  deleteExpiredSessions(db);
  return findUserBySessionToken(db, token);
}

type AuthOptions = {
  /** Allow `?token=` for navigations that cannot set Authorization (e.g. window.open). */
  allowQueryToken?: boolean;
};

function resolveRequestToken(req: Request, opts?: AuthOptions): string | null {
  const bearer = getBearerToken(req);
  if (bearer) return bearer;
  if (!opts?.allowQueryToken) return null;
  try {
    return new URL(req.url).searchParams.get("token");
  } catch {
    return null;
  }
}

export function requireAuth(
  req: Request,
  opts?: AuthOptions,
): { user: User; token: string } | { error: string; status: number } {
  const token = resolveRequestToken(req, opts);
  if (!token) return { error: "未登录", status: 401 };
  const user = getUserFromToken(token);
  if (!user) return { error: "会话已过期", status: 401 };
  return { user, token };
}

export function requireAdmin(
  req: Request,
  opts?: AuthOptions,
): { user: User; token: string } | { error: string; status: number } {
  const auth = requireAuth(req, opts);
  if ("error" in auth) return auth;
  if (!hasFeature(auth.user, "admin")) return { error: "无权限", status: 403 };
  return auth;
}
