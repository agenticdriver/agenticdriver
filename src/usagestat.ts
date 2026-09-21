import { appendFile } from "node:fs/promises";
import { z } from "zod";
import { abortable, DriverError } from "./errors.js";
import { readLimited, secureBaseUrl } from "./security.js";
import type { UsageRecord } from "./types.js";
import {
  AccountUsageIdentitySchema,
  UsageIdSchema,
  UsageRecordSchema,
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

const receiptSchema = z.object({
  schema: z.literal("usagestat.run-receipt.v1"),
  hostId: UsageIdSchema,
  eventId: z.uuid(),
  status: z.enum(["accepted", "duplicate"]),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type UsageStatReceipt = z.infer<typeof receiptSchema>;
const storedRunSchema = z.object({
  schema: z.literal("usagestat.stored-run.v1"),
  record: UsageRecordSchema,
  expiresAt: z.iso.datetime({ offset: true }),
  delivery: z.enum(["local", "pending", "delivered", "failed"]),
  attempts: z.number().int().nonnegative().max(4_294_967_295),
  deliveryError: z
    .string()
    .regex(/^[A-Z_]{1,64}$/)
    .nullish(),
});
const ingestionSchema = z.object({
  schema: z.literal("usagestat.run-ingestion.v1"),
  eventSchemas: z.array(z.string()),
  receiptSchema: z.literal("usagestat.run-receipt.v1"),
  maxEventBytes: z.number().int().positive(),
  requiresAccount: z.literal(true),
});

/** Optional Usagestat service dependency. Storage, retention and forwarding live in that backend. */
export class UsageStatClient {
  private readonly base: URL;
  private readonly accountBindings: UsageStatAccountBinding[];
  constructor(
    private readonly options: {
      url?: string;
      token?: string | (() => Promise<string>);
      /** First-hop telemetry I/O only; never a model execution deadline. */
      ingestionTimeoutMs?: number;
      fetch?: typeof globalThis.fetch;
      /** Explicit mappings for one trusted upstream source, including authorized subjects. */
      accounts?: UsageStatAccountBinding[];
    } = {},
  ) {
    this.base = secureBaseUrl(options.url ?? "http://127.0.0.1:6736");
    if (
      options.ingestionTimeoutMs !== undefined &&
      (!Number.isInteger(options.ingestionTimeoutMs) ||
        options.ingestionTimeoutMs < 100 ||
        options.ingestionTimeoutMs > 1500)
    )
      throw new DriverError(
        "USAGESTAT_CONFIG",
        "Usage capture timeout must be between 100 and 1500 milliseconds.",
      );
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
    const token =
      typeof this.options.token === "function"
        ? await this.options.token()
        : this.options.token;
    const response = await (this.options.fetch ?? globalThis.fetch)(
      new URL(path, this.base),
      {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
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
  private async metering<T>(
    path: string,
    schema: z.ZodType<T>,
    body?: string,
  ): Promise<T> {
    const signal = AbortSignal.timeout(this.options.ingestionTimeoutMs ?? 1000);
    try {
      const token = await abortable(
        Promise.resolve().then(() =>
          typeof this.options.token === "function"
            ? this.options.token()
            : this.options.token,
        ),
        signal,
      );
      if (
        !token ||
        token.length < 32 ||
        token.length > 4096 ||
        !/^[\x21-\x7e]+$/.test(token)
      )
        throw new DriverError(
          "USAGESTAT_AUTH",
          "Usage ingestion requires an explicit backend credential.",
        );
      const response = await abortable(
        (this.options.fetch ?? globalThis.fetch)(new URL(path, this.base), {
          method: body === undefined ? "GET" : "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          body,
          redirect: "error",
          signal,
        }),
        signal,
      );
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        const code =
          (
            {
              401: "USAGESTAT_AUTH",
              403: "USAGESTAT_SCOPE",
              404: "USAGESTAT_NOT_FOUND",
              409: "USAGESTAT_CONFLICT",
              410: "USAGESTAT_EXPIRED",
              429: "USAGESTAT_CAPACITY",
            } as Record<number, string>
          )[response.status] ?? "USAGESTAT_UNAVAILABLE";
        throw new DriverError(
          code,
          `Usagestat usage request returned HTTP ${response.status}.`,
          response.status === 429 || response.status >= 500,
        );
      }
      const value = JSON.parse(
        await abortable(readLimited(response, 100_000), signal),
      );
      const parsed = schema.safeParse(value);
      if (!parsed.success)
        throw new DriverError(
          "USAGESTAT_SCHEMA",
          "Usagestat returned an unsupported metering response.",
        );
      return parsed.data;
    } catch (error) {
      if (error instanceof DriverError) throw error;
      throw new DriverError(
        "USAGESTAT_UNAVAILABLE",
        "Usage capture was not acknowledged. Reconcile or resend the same record; do not repeat model execution.",
        true,
      );
    }
  }
  async ingestionProtocol() {
    const protocol = await this.metering(
      "v1/run-usage/protocol",
      ingestionSchema,
    );
    if (!protocol.eventSchemas.includes("agenticdriver.usage.v2"))
      throw new DriverError(
        "USAGESTAT_SCHEMA",
        "Usagestat does not accept this SDK's usage record version.",
      );
    return protocol;
  }
  /** Commits a stable event to Usagestat. Safe to resend this record after an uncertain acknowledgement. */
  async capture(input: UsageRecord): Promise<UsageStatReceipt> {
    const record = validateUsageRecord(input);
    if (!record.accountId)
      throw new DriverError(
        "USAGESTAT_UNBOUND",
        "Durable usage capture requires an explicit account binding.",
      );
    const body = JSON.stringify(record);
    if (Buffer.byteLength(body) > 65_536)
      throw new DriverError(
        "USAGESTAT_RECORD_SIZE",
        "Usage records must not exceed 65536 bytes.",
      );
    const receipt = await this.metering("v1/run-usage", receiptSchema, body);
    if (
      receipt.hostId !== record.hostId ||
      receipt.eventId !== record.eventId ||
      Date.parse(receipt.expiresAt) <= Date.now()
    )
      throw new DriverError(
        "USAGESTAT_SCHEMA",
        "Usagestat did not acknowledge this event identity with an active retention receipt.",
      );
    return receipt;
  }
  /** Thin driver callback. Configure a local Usagestat daemon for durable offline forwarding. */
  usageSink(): (record: UsageRecord) => Promise<void> {
    return async (record) => {
      await this.capture(record);
    };
  }
  async run(identity: AccountUsageIdentity, eventId: string) {
    const parsed = AccountUsageIdentitySchema.safeParse(identity);
    if (!parsed.success || !z.uuid().safeParse(eventId).success)
      throw new DriverError(
        "USAGESTAT_IDENTITY",
        "A complete account identity and event UUID are required for reconciliation.",
      );
    const result = await this.metering(
      `v1/run-usage/${encodeURIComponent(identity.hostId)}/${encodeURIComponent(eventId)}`,
      storedRunSchema,
    );
    const record = validateUsageRecord(result.record);
    if (
      record.eventId !== eventId ||
      record.hostId !== identity.hostId ||
      record.provider !== identity.provider ||
      record.accountId !== identity.accountId ||
      record.subject !== identity.subject
    )
      throw new DriverError(
        "USAGESTAT_SCOPE",
        "The backend returned a record outside the requested account scope.",
      );
    return { ...result, record };
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

  /** Explicit retry of a retained permanent forwarding failure after its cause is repaired. */
  async retryForwarding(identity: AccountUsageIdentity, eventId: string) {
    await this.run(identity, eventId);
    const result = await this.metering(
      `v1/run-usage/${encodeURIComponent(identity.hostId)}/${encodeURIComponent(eventId)}/retry`,
      z.object({
        schema: z.literal("usagestat.run-retry.v1"),
        hostId: UsageIdSchema,
        eventId: z.uuid(),
        status: z.literal("queued"),
      }),
      "",
    );
    if (result.hostId !== identity.hostId || result.eventId !== eventId)
      throw new DriverError(
        "USAGESTAT_SCHEMA",
        "Usagestat did not acknowledge this forwarding retry identity.",
      );
    return result;
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
