import { requireAuth, requireAdmin } from "@/server/infra/auth";
import { getDb } from "@/server/infra/db";
import { getUserBanStatus } from "@/server/data/users";
import type { User } from "@/shared/types/api";

type AuthOptions = {
  allowQueryToken?: boolean;
};

type AuthResult =
  { user: User; token: string } | { error: string; status: number };

function rejectIfBanned(userId: string): AuthResult | null {
  const ban = getUserBanStatus(getDb(), userId);
  if (ban.banned) return { error: "账号已被封禁", status: 403 };
  return null;
}

/** requireAuth + reject banned users (session may predate a ban). */
export function requireActiveAuth(
  req: Request,
  opts?: AuthOptions,
): AuthResult {
  const auth = requireAuth(req, opts);
  if ("error" in auth) return auth;
  const banned = rejectIfBanned(auth.user.id);
  if (banned) return banned;
  return auth;
}

/** requireAdmin + reject banned users. */
export function requireActiveAdmin(
  req: Request,
  opts?: AuthOptions,
): AuthResult {
  const auth = requireAdmin(req, opts);
  if ("error" in auth) return auth;
  const banned = rejectIfBanned(auth.user.id);
  if (banned) return banned;
  return auth;
}

export function isUserBanned(userId: string): boolean {
  return getUserBanStatus(getDb(), userId).banned;
}
