import { z } from "zod";
import { CodexProviderConfigSchema } from "./provider-config.js";

const revision = z.string().regex(/^[a-f0-9]{64}$/);
export const ProviderSetupConfigSchema = CodexProviderConfigSchema.omit({
  accountDirectory: true,
}).extend({
  accountId: CodexProviderConfigSchema.shape.id,
  binary: z.string().min(1).max(4096).optional(),
});
export type ProviderSetupConfig = z.infer<typeof ProviderSetupConfigSchema>;
export const ProviderSetupRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("start"),
      revision,
      method: z.literal("codex-device"),
      provider: ProviderSetupConfigSchema,
    })
    .strict(),
  z.object({ action: z.literal("list") }).strict(),
  z.object({ action: z.literal("status"), id: z.uuid() }).strict(),
  z.object({ action: z.literal("accept"), id: z.uuid() }).strict(),
  z.object({ action: z.literal("cancel"), id: z.uuid() }).strict(),
]);
export type ProviderSetupRequest = z.infer<typeof ProviderSetupRequestSchema>;
export const ProviderSetupAttemptSchema = z.object({
  id: z.uuid(),
  providerId: CodexProviderConfigSchema.shape.id,
  accountId: CodexProviderConfigSchema.shape.id,
  name: z.string().min(1).max(100),
  revision,
  method: z.literal("codex-device"),
  phase: z.enum([
    "starting",
    "waiting",
    "verifying",
    "ready",
    "succeeded",
    "failed",
    "cancelled",
    "expired",
  ]),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  interaction: z
    .object({
      type: z.literal("device-code"),
      verificationUrl: z.literal("https://auth.openai.com/codex/device"),
      userCode: z.string().regex(/^[A-Z0-9-]{4,40}$/),
    })
    .optional(),
  account: z
    .object({
      email: z.string().max(320).nullable(),
      plan: z.string().min(1).max(80),
      providerAccountId: z.string().min(1).max(256).optional(),
    })
    .optional(),
  error: z
    .object({
      code: z.string().min(1).max(80),
      message: z.string().min(1).max(512),
    })
    .optional(),
});
export type ProviderSetupAttempt = z.infer<typeof ProviderSetupAttemptSchema>;
export const ProviderSetupSnapshotSchema = z.object({
  version: z.literal(1),
  attempts: z.array(ProviderSetupAttemptSchema).max(32),
});
export type ProviderSetupSnapshot = z.infer<typeof ProviderSetupSnapshotSchema>;
export function matchesSetupResponse(
  value: ProviderSetupSnapshot,
  input: ProviderSetupRequest,
): boolean {
  if (new Set(value.attempts.map((a) => a.id)).size !== value.attempts.length)
    return false;
  if (input.action === "list") return true;
  if (value.attempts.length !== 1) return false;
  const attempt = value.attempts[0]!;
  return input.action === "start"
    ? attempt.providerId === input.provider.id &&
        attempt.accountId === input.provider.accountId &&
        attempt.revision === input.revision &&
        attempt.method === input.method
    : attempt.id === input.id;
}
/** The host transport supplies the authenticated caller, never an input request field. */
export interface ProviderSetup {
  request(input: unknown, caller: string): Promise<ProviderSetupSnapshot>;
  close(): Promise<void>;
}
