import { z } from "zod";
import { SecretReferenceSchema } from "./secret-types.js";
import { ContextMediaTypeSchema } from "./context-types.js";
export const CodexReasoningEffortSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,63}$/);
const instance = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/);
const model = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]{0,199}$/);
const modelAllowlist = z.array(model).max(1000);
const common = {
  id: instance,
  enabled: z.boolean().optional(),
  accountId: instance.optional(),
  name: z.string().min(1).max(100).optional(),
  /** Optional per-connection override. Omitted permits any explicitly selected model; empty denies all. */
  models: modelAllowlist.optional(),
};
const api = z
  .object({
    ...common,
    kind: z.enum([
      "openai",
      "anthropic",
      "gemini",
      "xai",
      "xai-responses",
      "openai-compatible",
    ]),
    apiKeyRef: SecretReferenceSchema,
    inputMediaTypes: z
      .record(model, z.array(ContextMediaTypeSchema).max(6))
      .optional(),
    baseUrl: z.string().url().optional(),
  })
  .strict();
const cli = z
  .object({
    ...common,
    kind: z.enum(["claude-code", "gemini-cli"]),
    accountDirectory: z.string().min(1).optional(),
    binary: z.string().min(1).optional(),
  })
  .strict();
const codexCli = cli.extend({
  kind: z.literal("codex"),
  reasoningEffort: CodexReasoningEffortSchema.optional(),
  applicationTools: z.literal("mcp").optional(),
});
export const HostProviderConfigSchema = z.union([
  api,
  cli,
  codexCli,
  z
    .object({
      ...common,
      kind: z.literal("extension"),
      // The versioned extension construction contract requires a model.
      models: modelAllowlist.min(1),
      extensionId: instance,
      extensionVersion: z.string().min(1).max(100),
      settings: z.record(z.string(), z.json()).default({}),
      secretRefs: z.record(instance, SecretReferenceSchema).default({}),
    })
    .strict(),
  z.object({ ...common, kind: z.literal("mock") }).strict(),
]);
export type HostProviderConfig = z.infer<typeof HostProviderConfigSchema>;
