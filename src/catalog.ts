/** App-facing presentation only. Authorization and quota collection stay on the server. */
import { z } from "zod";
import { DriverError } from "./errors.js";
import type { ProviderInfo } from "./types.js";
import {
  providerLimitsSchema,
  type UsageStatProvider,
  type UsageStatAccountQuota,
  type UsageStatQuotaIdentity,
} from "./usagestat-types.js";
export type {
  UsageStatProvider,
  UsageStatSnapshot,
  UsageStatLimits,
  UsageStatAccountQuota,
  UsageStatQuotaIdentity,
} from "./usagestat-types.js";

export type IconVariant = "monochrome" | "color";
const assetPath = z
  .string()
  .regex(/^\/(?!\/)[A-Za-z0-9_/-]+\/[a-f0-9]{64}\.(svg|png|jpeg|webp|txt)$/);
export const providerAssetSchema = z
  .object({
    providerId: z.string().min(1).max(128),
    variant: z.enum(["monochrome", "color"]),
    src: assetPath,
    mediaType: z.enum([
      "image/svg+xml",
      "image/png",
      "image/jpeg",
      "image/webp",
    ]),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    monochrome: z.boolean(),
    supportsCurrentColor: z.boolean(),
    license: z
      .object({
        id: z.string().min(1).max(128),
        attribution: z.string().min(1).max(2000),
        noticeUrl: assetPath,
      })
      .strict(),
  })
  .strict()
  .refine((asset) => {
    const extension = {
      "image/svg+xml": "svg",
      "image/png": "png",
      "image/jpeg": "jpeg",
      "image/webp": "webp",
    }[asset.mediaType];
    return (
      asset.src.endsWith(`/${asset.sha256}.${extension}`) &&
      asset.license.noticeUrl.endsWith(".txt") &&
      (!asset.supportsCurrentColor ||
        (asset.monochrome && asset.mediaType === "image/svg+xml"))
    );
  });
export type ProviderAsset = z.infer<typeof providerAssetSchema>;
export type ProviderIcon =
  | { kind: "asset"; asset: ProviderAsset; alt: string }
  | {
      kind: "fallback";
      text: string;
      alt: string;
      reason: "metadata-missing" | "icon-missing" | "variant-missing";
    };
export interface ProviderPresentation {
  providerId: string;
  name: string;
  vendor: string;
  authMode: ProviderInfo["authMode"];
  account?: { id: string; label: string };
  accountLabel: string;
  accessibleName: string;
  brandColor?: string;
  icon: ProviderIcon;
}

export function providerPresentation(
  provider: ProviderInfo,
  options: {
    metadata?: UsageStatProvider;
    account?: { id: string; label: string };
    assets?: readonly ProviderAsset[];
    variant?: IconVariant;
  } = {},
): ProviderPresentation {
  const metadata = options.metadata;
  if (
    metadata &&
    (!provider.usageStatId || metadata.id !== provider.usageStatId)
  )
    throw new DriverError(
      "CATALOG_MISMATCH",
      "Provider metadata must match the configured Usagestat provider ID.",
    );
  if (
    options.account &&
    (!options.account.id.trim() || !options.account.label.trim())
  )
    throw new DriverError(
      "CATALOG_ACCOUNT",
      "Account identity and display label must be explicit.",
    );
  const assets = z
    .array(providerAssetSchema)
    .max(1000)
    .safeParse(options.assets ?? []);
  if (!assets.success)
    throw new DriverError(
      "INVALID_ASSET_MANIFEST",
      "Use the reviewed provider asset manifest with local, immutable image and notice URLs.",
    );
  const name =
    metadata?.displayName?.trim() || metadata?.name?.trim() || provider.name;
  const accountLabel = options.account?.label ?? "Account not linked";
  const variant = options.variant ?? "monochrome";
  const matches = assets.data.filter(
    (asset) => asset.providerId === metadata?.id && asset.variant === variant,
  );
  if (matches.length > 1)
    throw new DriverError(
      "INVALID_ASSET_MANIFEST",
      "A provider icon variant must have exactly one asset.",
    );
  const asset = matches[0];
  const icon: ProviderIcon = asset
    ? { kind: "asset", asset, alt: name }
    : {
        kind: "fallback",
        text: Array.from(name.trim())[0]?.toLocaleUpperCase() ?? "?",
        alt: name,
        reason: !metadata
          ? "metadata-missing"
          : assets.data.some((a) => a.providerId === metadata.id)
            ? "variant-missing"
            : "icon-missing",
      };
  return {
    providerId: provider.id,
    name,
    vendor: provider.vendor,
    authMode: provider.authMode,
    ...(options.account
      ? { account: { id: options.account.id, label: options.account.label } }
      : {}),
    accountLabel,
    accessibleName: `${name} · ${accountLabel} (${provider.id})`,
    ...(metadata?.brandColor && /^#[a-f0-9]{6}$/i.test(metadata.brandColor)
      ? { brandColor: metadata.brandColor }
      : {}),
    icon,
  };
}

export interface QuotaPresentation {
  observation: "quota-snapshot";
  state: "fresh" | "stale" | "unknown" | "unbound" | "unavailable" | "error";
  label: string;
  quality: "reported" | "cached" | "estimated" | "unknown";
  fetchedAt?: string;
  ageMs?: number;
  resources: {
    id: string;
    label: string;
    used: number;
    unit: string;
    limit?: number;
    remaining?: number;
    utilization?: number;
    resetsAt?: string;
  }[];
}
const quotaIdentitySchema = z.object({
  hostId: z.string().min(1).max(128),
  provider: z.string().min(1).max(128),
  accountId: z.string().min(1).max(128),
  subject: z.string().min(1).max(128),
});
const timestamp = z.iso.datetime({ offset: true });
/** Pass only the result of the trusted server's exact accountLimits lookup. */
export function quotaPresentation(
  identity: UsageStatQuotaIdentity,
  quota: UsageStatAccountQuota | undefined,
  options: {
    maxAgeMs: number;
    now?: number;
    /** A failed refresh must remain visible even if an older successful snapshot was retained. */
    error?: unknown;
  },
): QuotaPresentation {
  const now = options.now ?? Date.now();
  if (
    !Number.isFinite(now) ||
    !Number.isSafeInteger(options.maxAgeMs) ||
    options.maxAgeMs <= 0
  )
    throw new DriverError(
      "QUOTA_DISPLAY_POLICY",
      "Quota freshness requires a finite clock and an explicit positive maximum age.",
    );
  const empty = (
    state: QuotaPresentation["state"],
    label: string,
  ): QuotaPresentation => ({
    observation: "quota-snapshot",
    state,
    label,
    quality: "unknown",
    resources: [],
  });
  if (!quotaIdentitySchema.safeParse(identity).success)
    return empty("unbound", "Quota account not linked");
  if (
    quota &&
    (!quotaIdentitySchema.safeParse(quota.identity).success ||
      (["hostId", "provider", "accountId", "subject"] as const).some(
        (key) => identity[key] !== quota.identity[key],
      ))
  )
    return empty("unbound", "Quota account does not match");
  if (options.error !== undefined) {
    if (
      options.error instanceof DriverError &&
      options.error.code === "QUOTA_UNBOUND"
    )
      return empty("unbound", "Quota account not linked");
    return empty("error", "Quota refresh failed");
  }
  if (!quota) return empty("unavailable", "Quota unavailable");
  const parsed = providerLimitsSchema.safeParse(quota.snapshot);
  if (!parsed.success || !quota.upstreamInstanceId)
    return empty("unknown", "Quota snapshot is invalid");
  const snapshot = parsed.data;
  if (snapshot.source === "error")
    return empty("error", "Quota refresh failed");
  const fetched = Date.parse(snapshot.fetchedAt);
  if (
    !timestamp.safeParse(snapshot.fetchedAt).success ||
    !Number.isFinite(fetched) ||
    fetched > now
  )
    return empty("unknown", "Quota timestamp cannot be verified");
  const resources = Object.entries(snapshot.resources).map(
    ([id, resource]) => ({ id, ...resource }),
  );
  if (!resources.length)
    return empty("unavailable", "No quota metrics reported");
  if (
    resources.some(
      (r) =>
        r.used < 0 ||
        (r.limit !== undefined && r.limit < 0) ||
        (r.resetsAt !== undefined && !timestamp.safeParse(r.resetsAt).success),
    )
  )
    return empty("unknown", "Quota metrics cannot be verified");
  const quality =
    snapshot.source === "cached"
      ? "cached"
      : snapshot.source === "local-estimate"
        ? "estimated"
        : snapshot.source
          ? "reported"
          : "unknown";
  const reset = resources.some(
    (r) => r.resetsAt !== undefined && Date.parse(r.resetsAt) <= now,
  );
  const ageMs = now - fetched;
  const stale = ageMs >= options.maxAgeMs || reset;
  return {
    observation: "quota-snapshot",
    state: stale ? "stale" : "fresh",
    quality,
    label: stale
      ? reset
        ? "Quota window ended; refresh required"
        : "Quota snapshot is stale"
      : quality === "cached"
        ? "Cached quota snapshot"
        : quality === "estimated"
          ? "Estimated quota snapshot"
          : quality === "unknown"
            ? "Quota snapshot; source unknown"
            : "Quota snapshot",
    fetchedAt: snapshot.fetchedAt,
    ageMs,
    resources,
  };
}
