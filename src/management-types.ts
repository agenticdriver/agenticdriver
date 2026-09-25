import { z } from "zod";
import { HostProviderConfigSchema } from "./provider-config.js";
export {
  HostProviderConfigSchema,
  type HostProviderConfig,
} from "./provider-config.js";

export const ManagementSnapshotSchema = z.object({
  version: z.literal(1),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  providers: z.array(HostProviderConfigSchema).max(32),
  supportedKinds: z.array(z.string().min(1).max(80)).max(32),
});
export type ManagementSnapshot = z.infer<typeof ManagementSnapshotSchema>;
export const ConfigureProviderSchema = z
  .object({
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    provider: HostProviderConfigSchema,
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
}
