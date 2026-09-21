import { randomUUID } from "node:crypto";
import { z } from "zod";
import { abortable, DriverError } from "./errors.js";
import { UsageAccumulator, UsagePolicy, type UsageOptions } from "./usage.js";
import type { EmbeddingAdapter, EmbeddingResult } from "./embeddings.js";
import type { ExecutionContext, UsageRecord } from "./types.js";

export interface EmbeddingUsageOptions {
  /** Use the same persistent host ID configured for the application's generation metering. */
  hostId: string;
  labels?: UsageOptions["labels"];
  retentionDays?: number;
  /** Supply UsageStatClient.usageSink() to reuse the existing usage backend. */
  onUsage(record: UsageRecord): void | Promise<void>;
  onTelemetryError?(error: unknown): void;
}

/** Emits existing v2 usage envelopes. Storage, retention and forwarding remain in Usagestat. */
export class EmbeddingUsage {
  private readonly policy?: UsagePolicy;
  constructor(
    adapters: EmbeddingAdapter[],
    private readonly options?: EmbeddingUsageOptions,
  ) {
    if (!options) return;
    if (
      !options.hostId ||
      typeof options.onUsage !== "function" ||
      Object.keys(options.labels ?? {}).length > 29
    )
      throw new DriverError(
        "INVALID_USAGE_CONFIG",
        "Embedding metering requires a persistent host ID, sink and at most 29 static labels.",
      );
    const identities = new Map<string, string>();
    for (const adapter of adapters) {
      if (adapter.info.vendor.length > 80)
        throw new DriverError(
          "INVALID_USAGE_CONFIG",
          "Embedding vendor labels must fit the existing usage schema.",
        );
      const identity = JSON.stringify([
        adapter.info.accountId,
        adapter.info.vendor,
        adapter.info.authMode,
        adapter.usageSource ?? "adapter-report",
      ]);
      const old = identities.get(adapter.info.providerId);
      if (old !== undefined && old !== identity)
        throw new DriverError(
          "INVALID_USAGE_CONFIG",
          "An embedding provider instance must bind to one account and measurement source.",
        );
      identities.set(adapter.info.providerId, identity);
    }
    this.policy = new UsagePolicy(
      {
        hostId: options.hostId,
        labels: options.labels,
        retentionDays: options.retentionDays,
        accounts: Object.fromEntries(
          adapters.map((adapter) => [
            adapter.info.providerId,
            adapter.info.accountId,
          ]),
        ),
      },
      adapters.map((adapter) => ({
        usageSource: adapter.usageSource,
        info: {
          id: adapter.info.providerId,
          name: adapter.info.providerId,
          vendor: adapter.info.vendor,
          authMode: adapter.info.authMode,
          capabilities: { tools: false, textStreaming: false },
        },
      })),
    );
  }
  async embed(
    adapter: EmbeddingAdapter,
    texts: readonly string[],
    purpose: "index" | "query",
    context: ExecutionContext,
  ): Promise<EmbeddingResult> {
    context.signal.throwIfAborted();
    const runId = randomUUID(),
      startedAt = Date.now(),
      meter = new UsageAccumulator(),
      identity = { ...adapter.info };
    let status: UsageRecord["status"] = "failed";
    meter.start();
    try {
      const result = await abortable(
        adapter.embed(texts, { ...context, runId }),
        context.signal,
      );
      meter.add(result.usage);
      status = "completed";
      return result;
    } catch (error) {
      if (context.signal.aborted) status = "cancelled";
      throw error;
    } finally {
      if (this.policy && this.options) {
        try {
          const record = this.policy.record({
            runId,
            provider: identity.providerId,
            model: identity.model,
            subject: context.subject,
            status,
            startedAt,
            finishedAt: Date.now(),
            meter,
          });
          record.metadata = {
            ...record.metadata,
            operation: "embedding",
            purpose,
            ...(z.uuid().safeParse(context.runId).success
              ? { parentRunId: context.runId }
              : {}),
          };
          await abortable(
            Promise.resolve(this.options.onUsage(record)),
            AbortSignal.timeout(2000),
          );
        } catch (error) {
          try {
            this.options.onTelemetryError?.(error);
          } catch {
            /* Telemetry never changes the execution outcome. */
          }
        }
      }
    }
  }
}
