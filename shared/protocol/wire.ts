import { z } from "zod";
import { actionContracts, type ActionName } from "./actions";
import { eventContracts, type ServerEventName } from "./events";
import { incidentPanicSchema } from "./errors";

export const PROTOCOL_VERSION = 3 as const;

export const actionNameSchema = z
  .string()
  .refine(
    (value): value is ActionName => value in actionContracts,
    "未知 Action",
  );

export const serverEventNameSchema = z
  .string()
  .refine(
    (value): value is ServerEventName =>
      value !== "remote.hello" && value in eventContracts,
    "未知 Event",
  );

/** Payloads remain opaque only at the frame layer and are decoded by contracts. */
export const requestFrameSchema = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    kind: z.literal("request"),
    id: z.string().min(1).max(128),
    user: z.string().nullable(),
    action: z.string().min(1).max(128),
    args: z.array(z.unknown()).max(8),
  })
  .strict();

export const authenticateFrameSchema = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    kind: z.literal("authenticate"),
    user: z.string().min(1).max(128),
    token: z.string().max(512),
  })
  .strict();

export const responseFrameSchema = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    kind: z.literal("response"),
    id: z.string(),
    user: z.string().nullable(),
    result: z.unknown(),
  })
  .strict();

export const eventFrameSchema = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    kind: z.literal("event"),
    user: z.string().nullable(),
    event: serverEventNameSchema,
    data: z.unknown(),
  })
  .strict();

export const helloFrameSchema = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    kind: z.literal("hello"),
    buildId: z.string(),
  })
  .strict();

export const authenticatedFrameSchema = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    kind: z.literal("authenticated"),
    user: z.string(),
    result: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true) }).strict(),
      z.object({ ok: z.literal(false), error: incidentPanicSchema }).strict(),
    ]),
  })
  .strict();

export const serverFrameSchema = z.discriminatedUnion("kind", [
  responseFrameSchema,
  eventFrameSchema,
  helloFrameSchema,
  authenticatedFrameSchema,
]);

export type RequestFrame = z.infer<typeof requestFrameSchema>;
export type AuthenticateFrame = z.infer<typeof authenticateFrameSchema>;
export type ResponseFrame = z.infer<typeof responseFrameSchema>;
export type EventFrame = z.infer<typeof eventFrameSchema>;
export type HelloFrame = z.infer<typeof helloFrameSchema>;
export type AuthenticatedFrame = z.infer<typeof authenticatedFrameSchema>;
