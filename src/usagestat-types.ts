/** Browser-safe descriptions of the existing Usagestat read API. No probes or storage. */
import { z } from "zod";

const iconVariantSchema = z
  .object({
    kind: z.string(),
    path: z.string(),
    monochrome: z.boolean().optional(),
    supportsCurrentColor: z.boolean().optional(),
  })
  .passthrough();
export const iconSchema = z
  .object({
    kind: z.string(),
    path: z.string().nullish(),
    url: z.string().nullish(),
    monochromePath: z.string().nullish(),
    colorPath: z.string().nullish(),
    monochrome: z.boolean().optional(),
    supportsCurrentColor: z.boolean().optional(),
    variants: z
      .object({
        monochrome: iconVariantSchema.nullish(),
        color: iconVariantSchema.nullish(),
      })
      .nullish(),
  })
  .passthrough();
export const providerSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    displayName: z.string().optional(),
    enabled: z.boolean().optional(),
    brandColor: z.string().nullish(),
    icon: iconSchema.nullish(),
  })
  .passthrough();
export const snapshotSchema = z
  .object({
    providerId: z.string(),
    displayName: z.string(),
    source: z.string().nullish(),
    plan: z.string().nullish(),
    fetchedAt: z.string(),
    metrics: z.array(
      z.object({ type: z.string(), label: z.string() }).passthrough(),
    ),
  })
  .passthrough();
export const providerLimitsSchema = z.object({
  displayName: z.string(),
  fetchedAt: z.string(),
  source: z.string().optional(),
  plan: z.string().optional(),
  resources: z.record(
    z.string(),
    z.object({
      used: z.number(),
      limit: z.number().optional(),
      remaining: z.number().optional(),
      utilization: z.number().optional(),
      unit: z.string(),
      resetsAt: z.string().optional(),
      label: z.string(),
    }),
  ),
});
export const limitsSchema = z.object({
  schema: z.literal("crossusage.limits.v1"),
  providers: z.record(z.string(), providerLimitsSchema),
  errors: z.array(z.object({ providerId: z.string(), message: z.string() })),
});
export type UsageStatProvider = z.infer<typeof providerSchema>;
export type UsageStatSnapshot = z.infer<typeof snapshotSchema>;
export type UsageStatLimits = z.infer<typeof limitsSchema>;
export interface UsageStatQuotaIdentity {
  hostId: string;
  provider: string;
  accountId: string;
  subject: string;
}
export interface UsageStatAccountQuota {
  identity: UsageStatQuotaIdentity;
  upstreamInstanceId: string;
  snapshot: z.infer<typeof providerLimitsSchema>;
}
