import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DriverError } from "./errors.js";
import {
  UsageSchema,
  type ProviderAdapter,
  type Usage,
  type UsageRecord,
} from "./types.js";

export const UsageIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/);
export const UsageOptionsSchema = z
  .object({
    hostId: UsageIdSchema.optional(),
    accounts: z.record(UsageIdSchema, UsageIdSchema).optional(),
    /** Static, nonsecret host labels. Untrusted request metadata is excluded. */
    labels: z
      .record(
        z.string().regex(/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/),
        z.string().max(128),
      )
      .refine((value) => Object.keys(value).length <= 32)
      .optional(),
    retentionDays: z.number().int().min(1).max(3650).optional(),
  })
  .strict();
export type UsageOptions = z.infer<typeof UsageOptionsSchema>;
export const AccountUsageIdentitySchema = z
  .object({
    hostId: UsageIdSchema,
    provider: UsageIdSchema,
    accountId: UsageIdSchema,
    subject: z.string().min(1).max(128),
  })
  .strict();
export type AccountUsageIdentity = z.infer<typeof AccountUsageIdentitySchema>;
export const USAGE_METRICS = [
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "reasoningTokens",
  "costUsd",
  "apiEquivalentCostUsd",
] as const;
/** A composite counter is known only when every component is reported. */
export function sumKnownCounts(
  ...values: (number | undefined)[]
): number | undefined {
  if (
    !values.length ||
    values.some(
      (value) =>
        value === undefined || !Number.isSafeInteger(value) || value < 0,
    )
  )
    return undefined;
  const sum = values.reduce<number>((total, value) => total + value!, 0);
  return Number.isSafeInteger(sum) ? sum : undefined;
}
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const UsageRecordSchema = z
  .object({
    schema: z.literal("agenticdriver.usage.v2"),
    eventId: z.uuid(),
    runId: z.uuid(),
    hostId: UsageIdSchema,
    accountId: UsageIdSchema.optional(),
    subject: z.string().min(1).max(128),
    provider: UsageIdSchema,
    vendor: z.string().min(1).max(80),
    model: z.string().min(1).max(200),
    authMode: z.enum(["api-key", "cli-session", "none"]),
    status: z.enum(["completed", "failed", "cancelled"]),
    source: z.enum([
      "provider-response",
      "cli-report",
      "adapter-report",
      "synthetic",
    ]),
    startedAt: z.iso.datetime({ offset: true }),
    finishedAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
    usage: UsageSchema.strict(),
    observedUsage: UsageSchema.strict(),
    coverage: z
      .object({
        startedSteps: count,
        completedSteps: count,
        reportedSteps: z
          .object(
            Object.fromEntries(
              USAGE_METRICS.map((field) => [field, count.optional()]),
            ) as Record<keyof Usage, z.ZodOptional<typeof count>>,
          )
          .strict(),
      })
      .strict(),
    durationMs: count,
    metadata: z
      .record(z.string().max(64), z.string().max(128))
      .refine((value) => Object.keys(value).length <= 32),
  })
  .strict();

/** Sanitize adapter measurements before they reach either a client or a sink. */
export function normalizeUsage(input: Usage | undefined): Usage {
  const result: Usage = {};
  for (const field of USAGE_METRICS) {
    const value = input?.[field];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
      continue;
    if (field.endsWith("Tokens") && !Number.isSafeInteger(value)) continue;
    result[field] = value;
  }
  if (
    result.inputTokens !== undefined &&
    (result.cachedInputTokens ?? 0) > result.inputTokens
  )
    delete result.cachedInputTokens;
  if (
    result.outputTokens !== undefined &&
    (result.reasoningTokens ?? 0) > result.outputTokens
  )
    delete result.reasoningTokens;
  return result;
}

export class UsageAccumulator {
  startedSteps = 0;
  completedSteps = 0;
  private readonly observed: Usage = {};
  private readonly reported: Partial<Record<keyof Usage, number>> = {};
  private readonly overflow = new Set<keyof Usage>();
  start() {
    this.startedSteps++;
  }
  add(input?: Usage): Usage {
    this.completedSteps++;
    const next = normalizeUsage(input);
    for (const field of USAGE_METRICS) {
      if (next[field] === undefined) continue;
      this.reported[field] = (this.reported[field] ?? 0) + 1;
      const value = (this.observed[field] ?? 0) + next[field];
      if (
        !Number.isFinite(value) ||
        (field.endsWith("Tokens") && !Number.isSafeInteger(value))
      )
        this.overflow.add(field);
      if (this.overflow.has(field)) delete this.observed[field];
      else this.observed[field] = value;
    }
    return next;
  }
  snapshot() {
    const usage: Usage = {};
    for (const field of USAGE_METRICS)
      if (
        this.startedSteps > 0 &&
        this.completedSteps === this.startedSteps &&
        this.reported[field] === this.startedSteps &&
        this.observed[field] !== undefined
      )
        usage[field] = this.observed[field];
    return {
      usage,
      observedUsage: { ...this.observed },
      coverage: {
        startedSteps: this.startedSteps,
        completedSteps: this.completedSteps,
        reportedSteps: { ...this.reported },
      },
    };
  }
}

export class UsagePolicy {
  readonly hostId: string;
  private readonly options: UsageOptions;
  private readonly instances = new Map<
    string,
    {
      vendor: string;
      authMode: UsageRecord["authMode"];
      source: UsageRecord["source"];
    }
  >();
  constructor(
    input: UsageOptions | undefined,
    providers: readonly Pick<ProviderAdapter, "info" | "usageSource">[],
  ) {
    const parsed = UsageOptionsSchema.safeParse(input ?? {});
    if (!parsed.success)
      throw new DriverError(
        "INVALID_USAGE_CONFIG",
        "Usage policy requires opaque identifiers, bounded nonsecret labels and valid retention settings.",
      );
    this.options = parsed.data;
    if (Object.keys(this.options.accounts ?? {}).length && !this.options.hostId)
      throw new DriverError(
        "USAGE_IDENTITY_REQUIRED",
        "Account bindings require an explicitly configured persistent host ID.",
      );
    this.hostId = this.options.hostId ?? randomUUID();
    for (const provider of providers)
      this.instances.set(provider.info.id, {
        vendor: provider.info.vendor,
        authMode: provider.info.authMode,
        source: provider.usageSource ?? "adapter-report",
      });
    if (
      Object.keys(this.options.accounts ?? {}).some(
        (id) => !this.instances.has(id),
      )
    )
      throw new DriverError(
        "INVALID_USAGE_CONFIG",
        "A usage account binding references an unconfigured provider instance.",
      );
  }
  identity(provider: string, subject: string) {
    if (!this.instances.has(provider))
      throw new DriverError(
        "UNKNOWN_PROVIDER",
        "The provider instance is not configured.",
      );
    const accounts = this.options.accounts;
    const accountId =
      accounts && Object.hasOwn(accounts, provider)
        ? accounts[provider]
        : undefined;
    return {
      hostId: this.hostId,
      provider,
      subject,
      ...(accountId ? { accountId } : {}),
    };
  }
  record(values: {
    runId: string;
    provider: string;
    subject: string;
    model: string;
    status: UsageRecord["status"];
    startedAt: number;
    finishedAt: number;
    meter: UsageAccumulator;
  }): UsageRecord {
    const { vendor, authMode, source } = this.instances.get(values.provider)!;
    const finishedAt = Math.max(values.startedAt, values.finishedAt);
    return {
      schema: "agenticdriver.usage.v2",
      eventId: values.runId,
      runId: values.runId,
      ...this.identity(values.provider, values.subject),
      vendor,
      authMode,
      source,
      model: values.model,
      status: values.status,
      startedAt: new Date(values.startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      durationMs: finishedAt - values.startedAt,
      ...(this.options.retentionDays
        ? {
            expiresAt: new Date(
              finishedAt + this.options.retentionDays * 86_400_000,
            ).toISOString(),
          }
        : {}),
      ...values.meter.snapshot(),
      metadata: { ...this.options.labels },
    };
  }
}

/** Validate a metering envelope before accepting it into a durable sink. Unknown versions fail closed. */
export function validateUsageRecord(input: unknown): UsageRecord {
  const parsed = UsageRecordSchema.safeParse(input);
  if (!parsed.success)
    throw new DriverError(
      "INVALID_USAGE_RECORD",
      "The metering record does not match the supported version 2 schema.",
    );
  const value = parsed.data;
  const start = Date.parse(value.startedAt),
    end = Date.parse(value.finishedAt);
  const coverage = value.coverage;
  let valid =
    value.eventId === value.runId &&
    end >= start &&
    value.durationMs === end - start &&
    coverage.completedSteps <= coverage.startedSteps;
  valid &&= value.expiresAt === undefined || Date.parse(value.expiresAt) > end;
  for (const field of USAGE_METRICS) {
    const reports = coverage.reportedSteps[field] ?? 0;
    valid &&= reports <= coverage.completedSteps;
    if (value.observedUsage[field] !== undefined) valid &&= reports > 0;
    if (value.usage[field] !== undefined)
      valid &&=
        coverage.startedSteps > 0 &&
        reports === coverage.startedSteps &&
        coverage.completedSteps === coverage.startedSteps &&
        value.usage[field] === value.observedUsage[field];
  }
  // Observed subtotals may cover different steps, so only complete totals have subset constraints.
  const normalized = normalizeUsage(value.usage);
  valid &&= USAGE_METRICS.every(
    (field) => normalized[field] === value.usage[field],
  );
  if (!valid)
    throw new DriverError(
      "INVALID_USAGE_RECORD",
      "The metering record has inconsistent identity, timestamps or measurement coverage.",
    );
  return value;
}

export function usageRecordExpired(
  record: UsageRecord,
  now = Date.now(),
): boolean {
  return record.expiresAt !== undefined && Date.parse(record.expiresAt) <= now;
}
