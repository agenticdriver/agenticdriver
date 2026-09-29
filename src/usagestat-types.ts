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
  schema: z.literal("agenticdriver.usagestat-limits.v1"),
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

// Unknown or malformed formats yield no unit, so the resource is omitted and
// admission sees an unknown observation rather than an invented one.
const resourceUnit = (format: unknown): string | undefined => {
  if (!format || typeof format !== "object") return undefined;
  const { kind, suffix } = format as { kind?: unknown; suffix?: unknown };
  if (kind === "percent" || kind === "dollars") return kind;
  if (kind !== "count" || (suffix !== undefined && typeof suffix !== "string"))
    return undefined;
  return typeof suffix === "string" && suffix.trim()
    ? `count:${suffix}`
    : "count";
};
const isoDateTime = z.iso.datetime({ offset: true });

/** Stable resource key from a display label, e.g. "Weekly (Sonnet)" -> "weekly-sonnet". */
export function resourceSlug(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "resource";
}

// Any explicit non-ready state (missing-auth, timed-out, credential mismatch, ...)
// is a failed observation even when progress lines are still present.
const failedSnapshot = (snapshot: UsageStatSnapshot) => {
  const state = (snapshot as { state?: unknown }).state;
  return (
    snapshot.source === "error" ||
    (state !== undefined && state !== null && state !== "ready") ||
    snapshot.metrics.some(
      (metric) => metric.type === "badge" && metric.label === "Error",
    )
  );
};

/**
 * SDK quota resources derived from Usagestat's native `/v1/usage` snapshots.
 * This is a client-side document, not an upstream limits endpoint.
 */
export function limitsFromSnapshots(
  snapshots: readonly UsageStatSnapshot[],
): UsageStatLimits {
  // Null-prototype dictionaries: ids such as "__proto__" stay ordinary keys.
  const providers: UsageStatLimits["providers"] = Object.create(null);
  const errors: UsageStatLimits["errors"] = [];
  for (const snapshot of snapshots) {
    if (failedSnapshot(snapshot)) {
      const badge = snapshot.metrics.find(
        (metric) => metric.type === "badge" && metric.label === "Error",
      ) as { text?: unknown } | undefined;
      errors.push({
        providerId: snapshot.providerId,
        message:
          typeof badge?.text === "string" ? badge.text : "Provider unavailable",
      });
    }
    const resources: UsageStatLimits["providers"][string]["resources"] =
      Object.create(null);
    // Keys are reserved for every progress line before validation, so omitting
    // a malformed line never shifts a later duplicate onto its key.
    const taken = new Set<string>();
    for (const metric of snapshot.metrics) {
      if (metric.type !== "progress") continue;
      const base = resourceSlug(metric.label);
      let key = base;
      for (let suffix = 2; taken.has(key); suffix += 1)
        key = `${base}-${suffix}`;
      taken.add(key);
      const { used, limit, format, resetsAt } = metric as {
        used?: unknown;
        limit?: unknown;
        format?: unknown;
        resetsAt?: unknown;
      };
      if (typeof used !== "number" || !Number.isFinite(used) || used < 0)
        continue;
      if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 0)
        continue;
      const unit = resourceUnit(format);
      if (!unit) continue;
      if (
        resetsAt !== undefined &&
        resetsAt !== null &&
        !(
          typeof resetsAt === "string" &&
          isoDateTime.safeParse(resetsAt).success
        )
      )
        continue;
      const capped = limit > 0;
      resources[key] = {
        used,
        unit,
        label: metric.label,
        ...(capped
          ? {
              limit,
              remaining: Math.max(0, limit - used),
              utilization: Math.min(10, Math.max(0, used / limit)),
            }
          : {}),
        ...(typeof resetsAt === "string" ? { resetsAt } : {}),
      };
    }
    providers[snapshot.providerId] = {
      displayName: snapshot.displayName,
      fetchedAt: snapshot.fetchedAt,
      ...(typeof snapshot.source === "string"
        ? { source: snapshot.source }
        : {}),
      ...(typeof snapshot.plan === "string" ? { plan: snapshot.plan } : {}),
      resources,
    };
  }
  return { schema: "agenticdriver.usagestat-limits.v1", providers, errors };
}
