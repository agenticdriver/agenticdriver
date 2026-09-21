import { z } from "zod";

export const PortableMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string().max(100_000),
  })
  .strict();
export type PortableMessage = z.infer<typeof PortableMessageSchema>;
const id = z.string().regex(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const provider = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/);
const model = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/);
export const SessionModeSchema = z.enum(["history", "native"]);
export type SessionMode = z.infer<typeof SessionModeSchema>;
export const SessionHandleSchema = z.object({ id, revision }).strict();
export type SessionHandle = z.infer<typeof SessionHandleSchema>;
export const SessionIdentitySchema = z.object({ id }).strict();
export type SessionIdentity = z.infer<typeof SessionIdentitySchema>;
export const SessionCreateSchema = z
  .object({
    provider,
    model,
    mode: SessionModeSchema,
    history: z.array(PortableMessageSchema).max(100).optional(),
    instructions: z.string().max(100_000).optional(),
  })
  .strict();
export type SessionCreate = z.infer<typeof SessionCreateSchema>;
export const SessionInfoSchema = z
  .object({
    id,
    revision,
    provider,
    model,
    mode: SessionModeSchema,
    state: z.enum(["ready", "running", "interrupted"]),
    createdAt: z.iso.datetime({ precision: 3 }),
    updatedAt: z.iso.datetime({ precision: 3 }),
    /** Idle retention is suspended while a run holds the session. */
    expiresAt: z.iso.datetime({ precision: 3 }).optional(),
  })
  .refine(
    (info) =>
      Date.parse(info.updatedAt) >= Date.parse(info.createdAt) &&
      (info.state === "running"
        ? info.expiresAt === undefined
        : info.expiresAt !== undefined &&
          Date.parse(info.expiresAt) > Date.parse(info.updatedAt)),
  );
export type SessionInfo = z.infer<typeof SessionInfoSchema>;
export const SessionSnapshotSchema = z.object({
  session: SessionInfoSchema,
  history: z.array(PortableMessageSchema).max(100),
  instructions: z.string().max(100_000).optional(),
});
export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;
export const SessionDeleteResultSchema = z.object({
  id,
  deleted: z.literal(true),
});
export type SessionDeleteResult = z.infer<typeof SessionDeleteResultSchema>;
export const SessionOperationSchema = z.enum([
  "create",
  "read",
  "continue",
  "delete",
]);
export type SessionOperation = z.infer<typeof SessionOperationSchema>;
export const SessionOptionsSchema = z
  .object({
    /** Required explicit idle retention; never a run deadline. */
    retentionMs: z.number().int().min(1).max(2_147_483_647),
    maxEntries: z.number().int().min(1).max(100_000).optional(),
    maxMessages: z.number().int().min(2).max(100).optional(),
    maxRecordBytes: z.number().int().min(1).max(1_000_000).optional(),
  })
  .strict();
export type SessionOptions = z.infer<typeof SessionOptionsSchema>;
export function validSessionResult(
  result: { provider: string; model: string; session?: SessionInfo },
  request: { session?: SessionHandle },
) {
  if (!request.session) return result.session === undefined;
  return (
    result.session !== undefined &&
    result.session.id === request.session.id &&
    result.session.revision === request.session.revision + 1 &&
    result.session.provider === result.provider &&
    result.session.model === result.model &&
    result.session.state === "ready"
  );
}
