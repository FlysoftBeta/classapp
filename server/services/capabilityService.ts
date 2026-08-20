import crypto from "node:crypto";
import { z } from "zod";
import {
  CAPABILITY_VERSION,
  LIST_CAPABILITY_TTL_MS,
  SEARCH_CAPABILITY_TTL_MS,
  capabilitySigningInput,
  type CapabilityPayload,
  type CapabilitySource,
} from "@/shared/access";

const payloadSchema = z
  .object({
    v: z.literal(CAPABILITY_VERSION),
    kind: z.string().min(1),
    id: z.string().min(1),
    ops: z.array(z.literal("read")).min(1),
    src: z.union([
      z.object({ type: z.literal("search") }).strict(),
      z
        .object({
          type: z.literal("collection"),
          kind: z.string().min(1),
          id: z.string().min(1),
          revision: z.number().int().nonnegative().optional(),
        })
        .strict(),
      z
        .object({
          type: z.literal("recovery"),
          kind: z.string().min(1),
          id: z.string().min(1),
        })
        .strict(),
    ]),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().nonnegative(),
  })
  .strict();

export type CapabilityVerifyFailure =
  | "invalid"
  | "expired"
  | "kind_mismatch"
  | "id_mismatch";

export type CapabilityVerifyResult =
  | { ok: true; payload: CapabilityPayload; token: string }
  | { ok: false; reason: CapabilityVerifyFailure };

function b64url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

function hmac(secret: string, input: string): Buffer {
  return crypto.createHmac("sha256", secret).update(input).digest();
}

function timingEqual(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export class CapabilityService {
  constructor(private readonly secret: string) {}

  sign(
    kind: string,
    id: string,
    source: CapabilitySource,
    now = Date.now(),
  ): string {
    const ttl =
      source.type === "search"
        ? SEARCH_CAPABILITY_TTL_MS
        : LIST_CAPABILITY_TTL_MS;
    const payload: CapabilityPayload = {
      v: CAPABILITY_VERSION,
      kind,
      id,
      ops: ["read"],
      src: source,
      iat: now,
      exp: now + ttl,
    };
    const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
    const mac = b64url(hmac(this.secret, capabilitySigningInput(payload)));
    return `c1.${body}.${mac}`;
  }

  verify(
    token: string,
    expected: { kind: string; id: string },
    now = Date.now(),
  ): CapabilityVerifyResult {
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== "c1") {
      return { ok: false, reason: "invalid" };
    }
    let json: unknown;
    try {
      json = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    } catch {
      return { ok: false, reason: "invalid" };
    }
    const parsed = payloadSchema.safeParse(json);
    if (!parsed.success) return { ok: false, reason: "invalid" };
    const payload = parsed.data;
    const expectedMac = hmac(this.secret, capabilitySigningInput(payload));
    let presented: Buffer;
    try {
      presented = Buffer.from(parts[2], "base64url");
    } catch {
      return { ok: false, reason: "invalid" };
    }
    if (!timingEqual(expectedMac, presented)) {
      return { ok: false, reason: "invalid" };
    }
    if (payload.kind !== expected.kind) {
      return { ok: false, reason: "kind_mismatch" };
    }
    if (payload.id !== expected.id) return { ok: false, reason: "id_mismatch" };
    if (payload.exp <= now) return { ok: false, reason: "expired" };
    return { ok: true, payload, token };
  }
}
