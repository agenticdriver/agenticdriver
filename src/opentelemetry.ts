import type {
  DiagnosticExporter,
  DiagnosticRecord,
  DiagnosticOutcome,
} from "./diagnostics.js";

/** Structural API ports: applications supply their installed OpenTelemetry API/SDK. */
export interface TelemetrySpanContext {
  traceId: string;
  spanId: string;
  traceFlags: number;
  isRemote?: boolean;
}
export interface TelemetrySpan {
  spanContext(): TelemetrySpanContext;
  setStatus(status: { code: 1 | 2 }): unknown;
  end(time?: number): void;
}
type Attributes = Record<string, string | number | boolean>;
export interface TelemetryTracer<C> {
  startSpan(
    name: string,
    options: { startTime: number; attributes: Attributes; kind: 0 | 1 | 2 },
    context: C,
  ): TelemetrySpan;
}
export interface TelemetryMeter {
  createCounter(
    name: string,
    options: { unit: string; description: string },
  ): { add(value: number, attributes: Attributes): void };
  createHistogram(
    name: string,
    options: { unit: string; description: string },
  ): { record(value: number, attributes: Attributes): void };
}
export interface OpenTelemetryOptions<C> {
  tracer: TelemetryTracer<C>;
  meter: TelemetryMeter;
  rootContext: C;
  /** Typically OpenTelemetry trace.setSpanContext. Never copies baggage or tracestate. */
  withSpanContext(context: C, span: TelemetrySpanContext): C;
}
const status = (outcome: DiagnosticOutcome | "rejected"): 1 | 2 =>
  outcome === "completed" || outcome === "replayed" ? 1 : 2;

/** Completed spans use original times. No global provider, network exporter or usage backend is installed. */
export function openTelemetryExporter<C>(
  options: OpenTelemetryOptions<C>,
): DiagnosticExporter {
  // Lazy construction keeps application meter callbacks outside the run's execution path.
  let instruments:
    | {
        operations: ReturnType<TelemetryMeter["createCounter"]>;
        progress: ReturnType<TelemetryMeter["createCounter"]>;
        duration: ReturnType<TelemetryMeter["createHistogram"]>;
      }
    | undefined;
  function exportRecord(
    record: Exclude<DiagnosticRecord, { kind: "progress" }>,
  ) {
    instruments ??= {
      operations: options.meter.createCounter("agenticdriver.operations", {
        unit: "1",
        description: "Sampled completed diagnostic operations",
      }),
      progress: options.meter.createCounter("agenticdriver.progress", {
        unit: "1",
        description: "Observed real progress in sampled runs",
      }),
      duration: options.meter.createHistogram("agenticdriver.duration", {
        unit: "ms",
        description: "Sampled operation and per-run phase duration",
      }),
    };
    const metricAttributes = { kind: record.kind, outcome: record.outcome };
    instruments.operations.add(1, metricAttributes);
    instruments.duration.record(record.durationMs, {
      ...metricAttributes,
      phase: record.kind,
    });
    const attributes: Attributes = {
      "agenticdriver.observation_id": record.observationId,
      "agenticdriver.outcome": record.outcome,
      ...(record.requestId
        ? { "agenticdriver.request_id": record.requestId }
        : {}),
    };
    if (record.kind === "run") {
      attributes["agenticdriver.run_id"] = record.runId;
      attributes["agenticdriver.dropped_spans"] = record.droppedSpans;
      if (record.provider)
        attributes["agenticdriver.provider"] = record.provider;
      if (record.model) attributes["agenticdriver.model"] = record.model;
    } else attributes["agenticdriver.operation"] = record.operation;
    let parent = options.rootContext;
    if (record.traceParent) {
      const [, traceId, spanId, flags] = record.traceParent.split("-");
      parent = options.withSpanContext(parent, {
        traceId: traceId!,
        spanId: spanId!,
        traceFlags: parseInt(flags!, 16),
        isRemote: true,
      });
    }
    const root = options.tracer.startSpan(
      `agenticdriver.${record.kind}`,
      {
        startTime: record.startedAt,
        attributes,
        kind: record.kind === "host" ? 1 : 0,
      },
      parent,
    );
    try {
      root.setStatus({ code: status(record.outcome) });
      if (record.kind === "run") {
        const runContext = options.withSpanContext(parent, root.spanContext());
        for (const [phase, total] of Object.entries(record.phases)) {
          if (total.count)
            instruments.duration.record(total.durationMs, {
              ...metricAttributes,
              phase,
            });
          if (total.progress)
            instruments.progress.add(total.progress, {
              ...metricAttributes,
              phase,
            });
        }
        for (const child of record.spans) {
          const span = options.tracer.startSpan(
            `agenticdriver.${child.phase}`,
            {
              kind: child.phase === "provider" ? 2 : 0,
              startTime: child.startedAt,
              attributes: {
                "agenticdriver.outcome": child.outcome,
                ...(child.name ? { "agenticdriver.name": child.name } : {}),
              },
            },
            runContext,
          );
          try {
            span.setStatus({ code: status(child.outcome) });
          } finally {
            span.end(child.startedAt + child.durationMs);
          }
        }
      }
    } finally {
      root.end(record.startedAt + record.durationMs);
    }
  }
  return {
    export(records, { signal }) {
      for (const record of records) {
        signal.throwIfAborted();
        // Live progress goes to structured hooks; traces/metrics receive its final aggregate.
        if (record.kind !== "progress") exportRecord(record);
      }
    },
  };
}
