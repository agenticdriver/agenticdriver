import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { abortable, DriverError } from "./errors.js";

export type DiagnosticOutcome =
  "completed" | "failed" | "cancelled" | "replayed";
export type DiagnosticPhase = "queue" | "provider" | "tool" | "context";
export interface DiagnosticCorrelation {
  /** An opaque UUID, never a prompt, email address, credential or business identifier. */
  requestId?: string;
  /** W3C version 00 only. Baggage and tracestate are deliberately not exported. */
  traceParent?: string;
}
export interface DiagnosticSpan {
  phase: DiagnosticPhase;
  startedAt: number;
  durationMs: number;
  outcome: DiagnosticOutcome;
  /** Opt-in host names only; never tool arguments or results. */
  name?: string;
}
export interface DiagnosticTotals {
  count: number;
  durationMs: number;
  progress: number;
}
export interface RunDiagnostic {
  schema: "agenticdriver.diagnostics.v1";
  kind: "run";
  observationId: string;
  runId: string;
  requestId?: string;
  traceParent?: string;
  startedAt: number;
  durationMs: number;
  outcome: DiagnosticOutcome;
  provider?: string;
  model?: string;
  phases: Record<DiagnosticPhase, DiagnosticTotals>;
  spans: DiagnosticSpan[];
  droppedSpans: number;
}
export interface ProgressDiagnostic {
  schema: "agenticdriver.diagnostics.v1";
  kind: "progress";
  observationId: string;
  runId: string;
  requestId?: string;
  at: number;
  phase: DiagnosticPhase;
  count: number;
}
export interface HostDiagnostic {
  schema: "agenticdriver.diagnostics.v1";
  kind: "host";
  observationId: string;
  operation:
    | "run"
    | "retrieval"
    | "job"
    | "session"
    | "tool"
    | "approval"
    | "discovery"
    | "protocol"
    | "other";
  startedAt: number;
  durationMs: number;
  outcome: "completed" | "failed" | "cancelled" | "rejected";
  requestId?: string;
  traceParent?: string;
}
export type DiagnosticRecord =
  RunDiagnostic | ProgressDiagnostic | HostDiagnostic;
export interface DiagnosticExporter {
  /** Called asynchronously, outside run execution. Must honor cancellation and not block the JS thread. */
  export(
    records: readonly DiagnosticRecord[],
    context: { signal: AbortSignal },
  ): Promise<void> | void;
}
export const DiagnosticsOptionsSchema = z
  .object({
    level: z.enum(["summary", "steps", "progress"]).default("summary"),
    includeNames: z.boolean().default(false),
    sampleRate: z.number().min(0).max(1).default(1),
    maxActiveRuns: z.number().int().min(1).max(1024).default(128),
    maxSpansPerRun: z.number().int().min(1).max(256).default(128),
    queueSize: z.number().int().min(1).max(1024).default(128),
    maxQueueBytes: z
      .number()
      .int()
      .min(1024)
      .max(16_000_000)
      .default(2_000_000),
    batchSize: z.number().int().min(1).max(64).default(16),
    /** Export infrastructure deadline only. It never limits a run. */
    exportTimeoutMs: z.number().int().min(1).max(30_000).default(1000),
    progressIntervalMs: z.number().int().min(250).max(60_000).default(1000),
    /** Explicit opt-in to opaque correlation fields. Other metadata is always excluded. */
    correlation: z
      .object({
        requestIdMetadataKey: z.string().min(1).max(64).optional(),
        traceParentMetadataKey: z.string().min(1).max(64).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type DiagnosticsOptions = z.input<typeof DiagnosticsOptionsSchema>;
const phases = ["queue", "provider", "tool", "context"] as const;
const emptyTotals = (): Record<DiagnosticPhase, DiagnosticTotals> =>
  Object.fromEntries(
    phases.map((phase) => [phase, { count: 0, durationMs: 0, progress: 0 }]),
  ) as Record<DiagnosticPhase, DiagnosticTotals>;
const add = (left: number, right = 1) =>
  Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, left + right));
const elapsed = (since: number) => Math.max(0, performance.now() - since);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export function diagnosticCorrelation(
  value: DiagnosticCorrelation = {},
): DiagnosticCorrelation {
  const requestId =
    typeof value.requestId === "string" && uuid.test(value.requestId)
      ? value.requestId.toLowerCase()
      : undefined;
  const parent =
    typeof value.traceParent === "string"
      ? /^00-([a-f0-9]{32})-([a-f0-9]{16})-(00|01)$/.exec(value.traceParent)
      : null;
  const traceParent =
    parent && !/^0+$/.test(parent[1]!) && !/^0+$/.test(parent[2]!)
      ? value.traceParent
      : undefined;
  return {
    ...(requestId ? { requestId } : {}),
    ...(traceParent ? { traceParent } : {}),
  };
}
export interface DiagnosticScope {
  progress(): void;
  end(outcome: DiagnosticOutcome): void;
}

/** Optional bounded operational telemetry. Billing and token accounting stay in Usagestat. */
export class Diagnostics {
  readonly options: Readonly<z.output<typeof DiagnosticsOptionsSchema>>;
  private active = 0;
  private queue: { record: DiagnosticRecord; bytes: number }[] = [];
  private queueBytes = 0;
  private scheduled = false;
  private exporting?: Promise<void>;
  private exportAbort?: AbortController;
  private disabled = false;
  private closed = false;
  private closing = false;
  private closingTask?: Promise<void>;
  private failures = 0;
  private readonly counters = {
    droppedRecords: 0,
    droppedRuns: 0,
    exportedRecords: 0,
    exportFailures: 0,
    exportTimeouts: 0,
  };
  private readonly totals = {
    runs: { completed: 0, failed: 0, cancelled: 0, replayed: 0 },
    host: { completed: 0, failed: 0, cancelled: 0, rejected: 0 },
    durationMs: 0,
    phases: emptyTotals(),
  };
  constructor(
    options: DiagnosticsOptions & { exporter?: DiagnosticExporter } = {},
  ) {
    const { exporter, ...settings } = options;
    const parsed = DiagnosticsOptionsSchema.safeParse(settings);
    if (
      !parsed.success ||
      (exporter !== undefined && typeof exporter.export !== "function")
    )
      throw new DriverError(
        "INVALID_DIAGNOSTICS_CONFIG",
        "Configure bounded diagnostic settings and a valid exporter.",
      );
    if (parsed.data.correlation) Object.freeze(parsed.data.correlation);
    this.options = Object.freeze(parsed.data);
    this.exporter = exporter;
  }
  private readonly exporter?: DiagnosticExporter;
  get stats() {
    return {
      ...this.counters,
      activeRuns: this.active,
      queuedRecords: this.queue.length,
      queuedBytes: this.queueBytes,
      exporterDisabled: this.disabled,
    };
  }
  metrics() {
    return structuredClone(this.totals);
  }
  correlation(
    metadata: Record<string, string> | undefined,
    trusted?: DiagnosticCorrelation,
  ): DiagnosticCorrelation {
    const keys = this.options.correlation;
    return diagnosticCorrelation({
      requestId:
        trusted?.requestId ??
        (keys?.requestIdMetadataKey
          ? metadata?.[keys.requestIdMetadataKey]
          : undefined),
      traceParent:
        trusted?.traceParent ??
        (keys?.traceParentMetadataKey
          ? metadata?.[keys.traceParentMetadataKey]
          : undefined),
    });
  }
  startRun(
    input: {
      runId: string;
      provider: string;
      model: string;
      metadata?: Record<string, string>;
      queuedAt?: number;
    },
    trusted?: DiagnosticCorrelation,
  ): DiagnosticRun | undefined {
    if (
      this.closed ||
      this.closing ||
      this.active >= this.options.maxActiveRuns
    ) {
      this.counters.droppedRuns = add(this.counters.droppedRuns);
      return;
    }
    this.active++;
    return new DiagnosticRun(
      this,
      input,
      this.correlation(input.metadata, trusted),
      Math.random() < this.options.sampleRate,
    );
  }
  /** HTTP records contain a fixed operation class, never paths, headers or authentication identities. */
  host(
    operation: HostDiagnostic["operation"],
    startedAt: number,
    durationMs: number,
    outcome: HostDiagnostic["outcome"],
    correlation?: DiagnosticCorrelation,
  ) {
    if (this.closed) return;
    this.totals.host[outcome] = add(this.totals.host[outcome]);
    if (Math.random() < this.options.sampleRate)
      this.enqueue({
        schema: "agenticdriver.diagnostics.v1",
        kind: "host",
        observationId: randomUUID(),
        operation,
        startedAt,
        durationMs,
        outcome,
        ...diagnosticCorrelation(correlation),
      });
  }
  /** Internal lifecycle completion; contains only the constructed, content-free snapshot. */
  finish(record: RunDiagnostic, sampled: boolean) {
    this.active--;
    this.totals.runs[record.outcome] = add(this.totals.runs[record.outcome]);
    this.totals.durationMs = add(this.totals.durationMs, record.durationMs);
    for (const phase of phases)
      for (const key of ["count", "durationMs", "progress"] as const)
        this.totals.phases[phase][key] = add(
          this.totals.phases[phase][key],
          record.phases[phase][key],
        );
    if (sampled) this.enqueue(record);
  }
  enqueue(record: DiagnosticRecord) {
    if (!this.exporter || this.closed || this.closing) return;
    const bytes = Buffer.byteLength(JSON.stringify(record));
    if (
      this.disabled ||
      this.queue.length >= this.options.queueSize ||
      this.queueBytes + bytes > this.options.maxQueueBytes
    ) {
      this.counters.droppedRecords = add(this.counters.droppedRecords);
      return;
    }
    this.queue.push({ record, bytes });
    this.queueBytes += bytes;
    this.schedule();
  }
  private schedule() {
    if (this.scheduled || this.exporting || this.disabled || this.closed)
      return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      if (!this.closed) this.pump();
    });
  }
  private pump() {
    if (this.exporting || !this.queue.length || this.disabled || this.closed)
      return;
    const batch = this.queue.splice(0, this.options.batchSize);
    for (const item of batch) this.queueBytes -= item.bytes;
    const controller = new AbortController();
    this.exportAbort = controller;
    const timer = setTimeout(
      () => controller.abort(new Error("Diagnostic export deadline")),
      this.options.exportTimeoutMs,
    );
    this.exporting = abortable(
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return this.exporter!.export(
          batch.map((item) => item.record),
          { signal: controller.signal },
        );
      }),
      controller.signal,
    )
      .then(
        () => {
          this.failures = 0;
          this.counters.exportedRecords = add(
            this.counters.exportedRecords,
            batch.length,
          );
        },
        () => {
          this.failures++;
          this.counters.exportFailures = add(this.counters.exportFailures);
          this.counters.droppedRecords = add(
            this.counters.droppedRecords,
            batch.length,
          );
          if (controller.signal.aborted)
            this.counters.exportTimeouts = add(this.counters.exportTimeouts);
          // A hung exporter can retain at most one batch. Never accumulate abandoned promises.
          if (controller.signal.aborted || this.failures >= 3) {
            this.disabled = true;
            this.counters.droppedRecords = add(
              this.counters.droppedRecords,
              this.queue.length,
            );
            this.queue = [];
            this.queueBytes = 0;
          }
        },
      )
      .finally(() => {
        clearTimeout(timer);
        this.exportAbort = undefined;
        this.exporting = undefined;
        this.schedule();
      });
  }
  /** Explicit shutdown/inspection only; run execution never waits for exporters. */
  async flush(): Promise<void> {
    while (
      !this.closed &&
      !this.disabled &&
      (this.exporting || this.queue.length)
    ) {
      this.pump();
      await this.exporting;
    }
  }
  close(): Promise<void> {
    this.closing = true;
    return (this.closingTask ??= this.flush().finally(() => {
      this.closed = true;
      this.exportAbort?.abort();
    }));
  }
}

export class DiagnosticRun {
  private readonly startedAt: number;
  private readonly started: number;
  private readonly observationId = randomUUID();
  private readonly totals = emptyTotals();
  private readonly spans: DiagnosticSpan[] = [];
  private readonly pending = new Set<DiagnosticScope>();
  private droppedSpans = 0;
  private finished = false;
  private lastProgress = -Infinity;
  constructor(
    private readonly owner: Diagnostics,
    private readonly input: {
      runId: string;
      provider: string;
      model: string;
      queuedAt?: number;
    },
    private readonly correlation: DiagnosticCorrelation,
    private readonly sampled: boolean,
  ) {
    const now = Date.now();
    const waiting =
      input.queuedAt !== undefined &&
      Number.isFinite(input.queuedAt) &&
      input.queuedAt >= 0 &&
      input.queuedAt <= now
        ? now - input.queuedAt
        : 0;
    this.startedAt = now - waiting;
    this.started = performance.now() - waiting;
    if (waiting) {
      this.totals.queue = { count: 1, durationMs: waiting, progress: 0 };
      if (sampled && owner.options.level !== "summary")
        this.spans.push({
          phase: "queue",
          startedAt: this.startedAt,
          durationMs: waiting,
          outcome: "completed",
        });
    }
  }
  stage(phase: DiagnosticPhase, name?: string): DiagnosticScope {
    if (this.finished) return { progress() {}, end() {} };
    const at = performance.now();
    let ended = false;
    const scope: DiagnosticScope = {
      progress: () => {
        if (!ended) this.progress(phase);
      },
      end: (outcome) => {
        if (ended) return;
        ended = true;
        this.pending.delete(scope);
        const durationMs = elapsed(at),
          total = this.totals[phase];
        total.count = add(total.count);
        total.durationMs = add(total.durationMs, durationMs);
        if (this.sampled && this.owner.options.level !== "summary") {
          if (this.spans.length < this.owner.options.maxSpansPerRun)
            this.spans.push({
              phase,
              startedAt: this.startedAt + (at - this.started),
              durationMs,
              outcome,
              ...(this.owner.options.includeNames && name
                ? { name: name.slice(0, 200) }
                : {}),
            });
          else this.droppedSpans = add(this.droppedSpans);
        }
      },
    };
    this.pending.add(scope);
    return scope;
  }
  progress(phase: DiagnosticPhase) {
    if (this.finished) return;
    this.totals[phase].progress = add(this.totals[phase].progress);
    if (
      !this.sampled ||
      this.owner.options.level !== "progress" ||
      elapsed(this.lastProgress) < this.owner.options.progressIntervalMs
    )
      return;
    this.lastProgress = performance.now();
    this.owner.enqueue({
      schema: "agenticdriver.diagnostics.v1",
      kind: "progress",
      observationId: this.observationId,
      runId: this.input.runId,
      requestId: this.correlation.requestId,
      at: this.startedAt + elapsed(this.started),
      phase,
      count: this.totals[phase].progress,
    });
  }
  finish(outcome: DiagnosticOutcome) {
    if (this.finished) return;
    for (const scope of this.pending) scope.end(outcome);
    this.finished = true;
    this.owner.finish(
      {
        schema: "agenticdriver.diagnostics.v1",
        kind: "run",
        observationId: this.observationId,
        runId: this.input.runId,
        ...this.correlation,
        startedAt: this.startedAt,
        durationMs: elapsed(this.started),
        outcome,
        ...(this.owner.options.includeNames
          ? { provider: this.input.provider, model: this.input.model }
          : {}),
        phases: this.totals,
        spans: this.spans,
        droppedSpans: this.droppedSpans,
      },
      this.sampled,
    );
  }
}
