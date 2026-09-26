import { z } from "zod";
import { HostProviderConfigSchema } from "./provider-config.js";
import type { ProviderSetup } from "./setup-types.js";
export {
  HostProviderConfigSchema,
  type HostProviderConfig,
} from "./provider-config.js";

/** Setup metadata, not account availability, execution permission or a live qualification. */
export const ProviderConnectionMethodSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
  label: z.string().min(1).max(100),
  description: z.string().min(1).max(1000),
  /** Unknown future interactions are display-only until the client supports them. */
  interaction: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
  credentialOwner: z.enum(["native-runtime", "host", "none"]),
});
export type ProviderConnectionMethod = z.infer<
  typeof ProviderConnectionMethodSchema
>;
export const ProviderDefinitionSchema = z.object({
  kind: z.string().min(1).max(80),
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(1000),
  category: z.enum(["native", "api", "compatible", "fixture"]),
  protocol: z.string().min(1).max(100),
  methods: z.array(ProviderConnectionMethodSchema).min(1).max(8),
  requirements: z.string().min(1).max(2000).optional(),
  docsUrl: z
    .string()
    .url()
    .regex(/^https:\/\//)
    .max(2000)
    .optional(),
});
export type ProviderDefinition = z.infer<typeof ProviderDefinitionSchema>;

export const ManagementSnapshotSchema = z.object({
  version: z.literal(1),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  providers: z.array(HostProviderConfigSchema).max(32),
  supportedKinds: z.array(z.string().min(1).max(80)).max(32),
  /** Optional for older hosts. Listing definitions never starts login or inference. */
  providerDefinitions: z.array(ProviderDefinitionSchema).max(32).optional(),
  /** Caller-specific execution grants. Management access alone grants no inference. */
  executionProviders: z.array(z.string().min(1).max(256)).max(256).optional(),
  /** Older hosts omit this and reject configure requests with remove. */
  removalSupported: z.boolean().optional(),
});
export type ManagementSnapshot = z.infer<typeof ManagementSnapshotSchema>;
export const ConfigureProviderSchema = z
  .object({
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    provider: HostProviderConfigSchema,
    /** Remove this exact instance from new runs; retain account credentials and grants. */
    remove: z.boolean().optional(),
    /** Write only. Stored in a new private host file; never included in responses. */
    apiKey: z
      .string()
      .min(1)
      .max(4096)
      .regex(/^[^\s\0]+$/)
      .optional(),
  })
  .strict();
export type ConfigureProvider = z.infer<typeof ConfigureProviderSchema>;

/** Trusted host implementation. The transport checks manageProviders before calling it. */
export interface ProviderManagement {
  snapshot(): ManagementSnapshot | Promise<ManagementSnapshot>;
  configure(input: unknown): Promise<ManagementSnapshot>;
  setup?: ProviderSetup;
}
