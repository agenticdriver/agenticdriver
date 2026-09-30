import { z } from "zod";

/** Callers cannot supply a download URL, version, executable or installation path. */
export const ProviderRuntimeRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status"), kind: z.literal("codex") }).strict(),
  z.object({ action: z.literal("install"), kind: z.literal("codex") }).strict(),
  z
    .object({
      action: z.literal("cancel"),
      kind: z.literal("codex"),
      id: z.uuid(),
    })
    .strict(),
]);
export type ProviderRuntimeRequest = z.infer<
  typeof ProviderRuntimeRequestSchema
>;
export const ProviderRuntimeInfoSchema = z.object({
  kind: z.literal("codex"),
  version: z.literal("0.157.0"),
  platform: z.literal("linux-x64"),
  phase: z.enum([
    "missing",
    "downloading",
    "verifying",
    "installed",
    "failed",
    "cancelled",
  ]),
  archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
  downloadBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().positive(),
  canCancel: z.boolean(),
  id: z.uuid().optional(),
  updatedAt: z.iso.datetime().optional(),
  /** Host-local path; returned only after integrity and version checks. */
  binary: z.string().min(1).max(4096).optional(),
  error: z
    .object({
      code: z.string().min(1).max(80),
      message: z.string().min(1).max(512),
    })
    .optional(),
});
export type ProviderRuntimeInfo = z.infer<typeof ProviderRuntimeInfoSchema>;
export const ProviderRuntimeSnapshotSchema = z.object({
  version: z.literal(1),
  runtimes: z.array(ProviderRuntimeInfoSchema).length(1),
});
export type ProviderRuntimeSnapshot = z.infer<
  typeof ProviderRuntimeSnapshotSchema
>;
export { matchesRuntimeResponse } from "./runtime-validation.js";
export interface ProviderRuntimes {
  request(input: unknown, caller: string): Promise<ProviderRuntimeSnapshot>;
  close(): Promise<void>;
}
