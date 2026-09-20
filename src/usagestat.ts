import { appendFile } from "node:fs/promises";
import { z } from "zod";
import { DriverError } from "./errors.js";
import { readLimited, secureBaseUrl } from "./security.js";
import type { UsageRecord } from "./types.js";
import {
  AccountUsageIdentitySchema,
  UsageIdSchema,
  validateUsageRecord,
  type AccountUsageIdentity,
} from "./usage.js";

const accountBindingSchema = AccountUsageIdentitySchema.omit({ subject: true })
  .extend({
    instanceId: UsageIdSchema,
    subjects: z
      .array(z.string().min(1).max(128))
      .min(1)
      .max(100)
      .refine((values) => new Set(values).size === values.length),
  })
  .strict();
export type UsageStatAccountBinding = z.infer<typeof accountBindingSchema>;

const iconSchema = z
  .object({
    kind: z.string(),
    path: z.string().nullish(),
    url: z.string().nullish(),
    colorPath: z.string().nullish(),
    monochrome: z.boolean().optional(),
    supportsCurrentColor: z.boolean().optional(),
  })
  .passthrough();
const providerSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    displayName: z.string().optional(),
    enabled: z.boolean().optional(),
    brandColor: z.string().nullish(),
    icon: iconSchema.nullish(),
  })
  .passthrough();
const snapshotSchema = z
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
const limitsSchema = z.object({
  schema: z.literal("crossusage.limits.v1"),
  providers: z.record(
    z.string(),
    z.object({
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
    }),
  ),
  errors: z.array(z.object({ providerId: z.string(), message: z.string() })),
});
export type UsageStatProvider = z.infer<typeof providerSchema>;
export type UsageStatSnapshot = z.infer<typeof snapshotSchema>;
export type UsageStatLimits = z.infer<typeof limitsSchema>;

/** Read existing Usagestat APIs. Per-run records use a separate sink; Usagestat has no ingest API. */
export class UsageStatClient {
  private readonly base: URL;
  private readonly accountBindings: UsageStatAccountBinding[];
  constructor(
    private readonly options: {
      url?: string;
      token?: string;
      fetch?: typeof globalThis.fetch;
      /** Explicit mappings for one trusted upstream source, including authorized subjects. */
      accounts?: UsageStatAccountBinding[];
    } = {},
  ) {
    this.base = secureBaseUrl(options.url ?? "http://127.0.0.1:6736");
    const parsed = z
      .array(accountBindingSchema)
      .max(1000)
      .safeParse(options.accounts ?? []);
    if (!parsed.success)
      throw new DriverError(
        "INVALID_QUOTA_BINDING",
        "Quota mappings require explicit host, provider, account, upstream instance and authorized subjects.",
      );
    this.accountBindings = parsed.data;
    const subjects = new Set<string>(),
      upstream = new Map<string, string>();
    for (const binding of this.accountBindings) {
      const account = JSON.stringify([binding.hostId, binding.accountId]);
      if (
        upstream.has(binding.instanceId) &&
        upstream.get(binding.instanceId) !== account
      )
        throw new DriverError(
          "INVALID_QUOTA_BINDING",
          "One upstream quota instance cannot be assigned to different execution accounts.",
        );
      upstream.set(binding.instanceId, account);
      for (const subject of binding.subjects) {
        const key = JSON.stringify([
          binding.hostId,
          binding.provider,
          binding.accountId,
          subject,
        ]);
        if (subjects.has(key))
          throw new DriverError(
            "INVALID_QUOTA_BINDING",
            "Each account/subject binding must select exactly one upstream instance.",
          );
        subjects.add(key);
      }
    }
  }
  private async get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const response = await (this.options.fetch ?? globalThis.fetch)(
      new URL(path, this.base),
      {
        headers: this.options.token
          ? { Authorization: `Bearer ${this.options.token}` }
          : {},
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new DriverError(
        "USAGESTAT_ERROR",
        `Usagestat returned HTTP ${response.status}.`,
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(await readLimited(response));
    } catch {
      throw new DriverError(
        "USAGESTAT_SCHEMA",
        "Usagestat returned an unreadable response document.",
      );
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      throw new DriverError(
        "USAGESTAT_SCHEMA",
        "Usagestat returned an unsupported response schema.",
      );
    return parsed.data;
  }
  providers() {
    return this.get("v1/providers", z.array(providerSchema));
  }
  usage() {
    return this.get("v1/usage", z.array(snapshotSchema));
  }
  limits() {
    return this.get("v1/limits", limitsSchema);
  }
  async accountLimits(identity: AccountUsageIdentity) {
    const parsed = AccountUsageIdentitySchema.safeParse(identity);
    const binding = parsed.success
      ? this.accountBindings.find(
          (entry) =>
            entry.hostId === parsed.data.hostId &&
            entry.provider === parsed.data.provider &&
            entry.accountId === parsed.data.accountId &&
            entry.subjects.includes(parsed.data.subject),
        )
      : undefined;
    if (!binding || !parsed.success)
      throw new DriverError(
        "QUOTA_UNBOUND",
        "No authorized quota source is bound to this execution account and subject.",
      );
    const document = await this.get(
      `v1/limits/${encodeURIComponent(binding.instanceId)}`,
      limitsSchema,
    );
    const snapshot = Object.hasOwn(document.providers, binding.instanceId)
      ? document.providers[binding.instanceId]
      : undefined;
    if (
      !snapshot ||
      snapshot.source === "error" ||
      document.errors.some((error) => error.providerId === binding.instanceId)
    )
      throw new DriverError(
        "QUOTA_UNAVAILABLE",
        "The bound quota source has no usable snapshot for this account.",
      );
    return {
      identity: parsed.data,
      upstreamInstanceId: binding.instanceId,
      snapshot,
    };
  }
}

/** Append-only local metering. The parent directory must exist. No prompts, credentials, or outputs. */
export function jsonlUsageSink(
  path: string,
): (record: UsageRecord) => Promise<void> {
  let pending = Promise.resolve();
  return (record) => {
    // Snapshot validated data before a caller or another sink can mutate it.
    const serialized = JSON.stringify(validateUsageRecord(record));
    const next = pending
      .catch(() => {})
      .then(() => appendFile(path, `${serialized}\n`, { mode: 0o600 }));
    pending = next;
    return next;
  };
}
