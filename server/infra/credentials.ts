import crypto from "node:crypto";
import type { Database } from "better-sqlite3";
import { getPinSecret } from "@/server/infra/db";

/** Create a PIN hasher bound to this Runtime's database secret. */
export function createPinHasher(db: Database): (pin: string) => string {
  const secret = getPinSecret(db);
  return (pin) => crypto.createHmac("sha256", secret).update(pin).digest("hex");
}

export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString("hex");
}
