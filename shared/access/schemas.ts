import { z } from "zod";

const object = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

export const accessGrantSchema = z.union([
  object({ mode: z.literal("owner") }),
  object({
    mode: z.enum(["readwrite", "read"]),
    shareable: z.boolean(),
  }),
]);

export const accessFlagsSchema = object({
  read: z.boolean(),
  write: z.boolean(),
  own: z.boolean(),
  shareRead: z.boolean(),
  shareWrite: z.boolean(),
  shareOwn: z.boolean(),
});

export const principalRefSchema = object({
  kind: z.enum(["user", "group"]),
  id: z.string().min(1),
});

export const capabilityTokenSchema = z
  .string()
  .min(16)
  .max(4096)
  .regex(/^c1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

export const accessBindingSchema = object({
  principal: principalRefSchema,
  grants: z.array(accessGrantSchema).min(1),
  flags: accessFlagsSchema,
});

export const ownedListAccessSchema = object({
  flags: accessFlagsSchema,
  bindings: z.array(accessBindingSchema).optional(),
});

export type AccessGrantWire = z.output<typeof accessGrantSchema>;
export type AccessFlagsWire = z.output<typeof accessFlagsSchema>;
export type PrincipalRef = z.output<typeof principalRefSchema>;
export type AccessBindingView = z.output<typeof accessBindingSchema>;
