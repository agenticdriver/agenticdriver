import { appendFile } from "node:fs/promises";
import { z } from "zod";
import { DriverError } from "./errors.js";
import { readLimited, secureBaseUrl } from "./security.js";
import type { UsageRecord } from "./types.js";

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
  constructor(
    private readonly options: {
      url?: string;
      token?: string;
      fetch?: typeof globalThis.fetch;
    } = {},
  ) {
    this.base = secureBaseUrl(options.url ?? "http://127.0.0.1:6736");
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
    const parsed = schema.safeParse(JSON.parse(await readLimited(response)));
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
}

/** Append-only local metering. The parent directory must exist. No prompts, credentials, or outputs. */
export function jsonlUsageSink(
  path: string,
): (record: UsageRecord) => Promise<void> {
  let pending = Promise.resolve();
  return (record) => {
    const next = pending
      .catch(() => {})
      .then(() =>
        appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 }),
      );
    pending = next;
    return next;
  };
}
