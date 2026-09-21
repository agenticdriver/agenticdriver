import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  setImmediate as immediate,
  setTimeout as delay,
} from "node:timers/promises";
import { ROOT_CONTEXT, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  AlwaysOnSampler,
} from "@opentelemetry/sdk-trace-base";
import {
  MeterProvider,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  AggregationTemporality,
} from "@opentelemetry/sdk-metrics";
import {
  Diagnostics,
  diagnosticCorrelation,
  type DiagnosticRecord,
  type RunDiagnostic,
} from "../src/diagnostics.js";
import { openTelemetryExporter } from "../src/opentelemetry.js";
import { AgenticDriver } from "../src/driver.js";
import { AgenticClient } from "../src/client.js";
import { mockProvider } from "../src/providers/mock.js";
import { MemoryOperationStore } from "../src/operations.js";
import { serve } from "../src/server.js";
import type { RunRequest } from "../src/types.js";

const base: RunRequest = {
  provider: "mock",
  model: "demo",
  input: "private-prompt-marker",
};
const requestId = "68b8fb27-f22f-4d6b-9c53-1bc2ab466321";
const traceParent = "00-11111111111111111111111111111111-2222222222222222-01";
function collecting(
  options: ConstructorParameters<typeof Diagnostics>[0] = {},
) {
  const records: DiagnosticRecord[] = [];
  const diagnostics = new Diagnostics({
    ...options,
    exporter: {
      export(batch) {
        records.push(...structuredClone(batch));
      },
    },
  });
  return { diagnostics, records };
}

test("run, provider, tool and queue diagnostics correlate opaque IDs without exporting content", async () => {
  const { diagnostics, records } = collecting({
    level: "progress",
    correlation: {
      requestIdMetadataKey: "requestId",
      traceParentMetadataKey: "traceparent",
    },
  });
  let calls = 0,
    metered = 0;
  const driver = new AgenticDriver({
    diagnostics,
    providers: [
      mockProvider((_input, context) => {
        calls++;
        context.reportProgress();
        if (calls === 1)
          return {
            text: "private-native-text-marker",
            native: { private: "private-reasoning-marker" },
            toolCalls: [
              {
                id: "private-call-id",
                name: "private_tool",
                arguments: { secret: "private-argument-marker" },
              },
            ],
          };
        context.emitText("private-answer-marker");
        return { text: "private-answer-marker", usage: { inputTokens: 1 } };
      }),
    ],
    tools: [
      {
        name: "private_tool",
        description: "private-tool-description",
        inputSchema: { type: "object" },
        execute(_args, context) {
          context.reportProgress();
          return { password: "private-output-marker" };
        },
      },
    ],
    onUsage() {
      metered++;
    },
  });
  const result = await driver.run(
    {
      ...base,
      tools: ["private_tool"],
      instructions: "private-instruction-marker",
      metadata: {
        requestId,
        traceparent: traceParent,
        secret: "private-metadata-marker",
      },
    },
    { subject: "private-user-marker" },
  );
  await diagnostics.flush();
  const summary = records.find(
    (record): record is RunDiagnostic => record.kind === "run",
  )!;
  assert.equal(summary.runId, result.runId);
  assert.equal(summary.requestId, requestId);
  assert.equal(summary.traceParent, traceParent);
  assert.equal(summary.outcome, "completed");
  assert.equal(summary.phases.provider.count, 2);
  assert.equal(summary.phases.tool.count, 1);
  assert.ok(summary.phases.provider.progress >= 2);
  assert.equal(summary.phases.tool.progress, 1);
  assert.deepEqual(
    summary.spans.map((span) => span.phase),
    ["queue", "provider", "tool", "provider"],
  );
  assert.equal(summary.provider, undefined);
  assert.equal(summary.model, undefined);
  assert.equal(JSON.stringify(records).includes("private"), false);
  assert.equal(
    JSON.stringify(records).includes("Tokens"),
    false,
    "Diagnostics do not duplicate usage accounting",
  );
  assert.equal(metered, 1);
  assert.equal(calls, 2);
  assert.equal(diagnostics.stats.activeRuns, 0);
  assert.ok(records.some((record) => record.kind === "progress"));
  await diagnostics.close();
});

test("the bridge works with actual OpenTelemetry tracing and metrics without global registration", async () => {
  const spans = new InMemorySpanExporter();
  const traces = new BasicTracerProvider({
    sampler: new AlwaysOnSampler(),
    spanProcessors: [new SimpleSpanProcessor(spans)],
  });
  const metricExport = new InMemoryMetricExporter(
    AggregationTemporality.CUMULATIVE,
  );
  const meter = new MeterProvider({
    readers: [
      new PeriodicExportingMetricReader({
        exporter: metricExport,
        exportIntervalMillis: 60_000,
      }),
    ],
  });
  const diagnostics = new Diagnostics({
    level: "steps",
    exporter: openTelemetryExporter({
      tracer: traces.getTracer("fixture"),
      meter: meter.getMeter("fixture"),
      rootContext: ROOT_CONTEXT,
      withSpanContext: trace.setSpanContext,
    }),
  });
  try {
    const driver = new AgenticDriver({
      diagnostics,
      providers: [
        mockProvider((_input, context) => {
          context.reportProgress();
          return { text: "sensitive-output" };
        }),
      ],
    });
    const result = await driver.run(base, {
      diagnostics: { requestId, traceParent },
    });
    await diagnostics.flush();
    await traces.forceFlush();
    await meter.forceFlush();
    const finished = spans.getFinishedSpans(),
      root = finished.find((span) => span.name === "agenticdriver.run")!;
    assert.equal(
      root.spanContext().traceId,
      "11111111111111111111111111111111",
    );
    assert.equal(root.parentSpanContext?.spanId, "2222222222222222");
    assert.equal(root.attributes["agenticdriver.request_id"], requestId);
    assert.equal(root.attributes["agenticdriver.run_id"], result.runId);
    assert.ok(
      finished.some(
        (span) =>
          span.name === "agenticdriver.provider" &&
          span.parentSpanContext?.spanId === root.spanContext().spanId,
      ),
    );
    const metrics = metricExport
      .getMetrics()
      .flatMap((resource) =>
        resource.scopeMetrics.flatMap((scope) => scope.metrics),
      );
    assert.ok(
      metrics.some(
        (metric) => metric.descriptor.name === "agenticdriver.duration",
      ),
    );
    for (const metric of metrics)
      for (const point of metric.dataPoints)
        assert.ok(
          Object.keys(point.attributes).every((key) =>
            ["kind", "outcome", "phase"].includes(key),
          ),
        );
    assert.equal(
      JSON.stringify(finished.map((span) => span.attributes)).includes(
        "sensitive",
      ),
      false,
    );
    assert.equal(JSON.stringify(metrics).includes(result.runId), false);
  } finally {
    await diagnostics.close();
    await traces.shutdown();
    await meter.shutdown();
  }
});

test("hanging exporters never block runs and retain only one abandoned batch", async () => {
  let exportCalls = 0,
    providerCalls = 0,
    exportedSignal: AbortSignal | undefined,
    began!: () => void;
  const begun = new Promise<void>((resolve) => {
    began = resolve;
  });
  const diagnostics = new Diagnostics({
    level: "progress",
    queueSize: 2,
    batchSize: 1,
    exportTimeoutMs: 1000,
    exporter: {
      export(_records, { signal }) {
        exportCalls++;
        exportedSignal = signal;
        began();
        return new Promise(() => {});
      },
    },
  });
  const driver = new AgenticDriver({
    diagnostics,
    providers: [
      mockProvider(async (_input, context) => {
        providerCalls++;
        context.reportProgress();
        await begun;
        return { text: "answer" };
      }),
    ],
  });
  assert.equal((await driver.run(base)).text, "answer");
  assert.equal(
    exportedSignal!.aborted,
    false,
    "The run returns while its exporter is still pending",
  );
  for (let n = 0; n < 12; n++) await driver.run(base);
  assert.ok(diagnostics.stats.queuedRecords <= 2);
  assert.ok(diagnostics.stats.droppedRecords > 0);
  await diagnostics.flush();
  assert.equal(exportedSignal!.aborted, true);
  assert.equal(diagnostics.stats.exporterDisabled, true);
  assert.equal(exportCalls, 1);
  await driver.run(base);
  assert.equal(exportCalls, 1);
  assert.equal(providerCalls, 14);
  assert.equal(diagnostics.stats.exportTimeouts, 1);
  assert.equal(diagnostics.stats.activeRuns, 0);
  await diagnostics.close();
});

test("throwing exporters trip a bounded circuit and never retry model work or expose exceptions", async () => {
  let exported = 0,
    generated = 0;
  const diagnostics = new Diagnostics({
    exporter: {
      export() {
        exported++;
        throw new Error("private-exporter-secret");
      },
    },
  });
  const driver = new AgenticDriver({
    diagnostics,
    providers: [
      mockProvider(() => {
        generated++;
        return { text: "ok" };
      }),
    ],
  });
  for (let n = 0; n < 5; n++) {
    assert.equal((await driver.run(base)).text, "ok");
    await diagnostics.flush();
  }
  assert.equal(generated, 5);
  assert.equal(exported, 3);
  assert.equal(diagnostics.stats.exporterDisabled, true);
  assert.equal(JSON.stringify(diagnostics.stats).includes("private"), false);
  await diagnostics.close();
});

test("diagnostic sampling, progress, span/byte bounds and metric dimensions do not grow with labels", async () => {
  const { diagnostics, records } = collecting({
    level: "progress",
    maxActiveRuns: 1,
    maxSpansPerRun: 2,
    maxQueueBytes: 1024,
    correlation: {
      requestIdMetadataKey: "secret",
      traceParentMetadataKey: "bad",
    },
  });
  const input = {
    runId: randomUUID(),
    provider: "private-provider",
    model: "private-model",
    metadata: { secret: "private-data", bad: "private-token" },
  };
  const observation = diagnostics.startRun(input)!;
  assert.equal(diagnostics.startRun(input), undefined);
  const span = observation.stage("provider", "private-name");
  for (let n = 0; n < 20_000; n++) span.progress();
  span.end("completed");
  for (let n = 0; n < 300; n++)
    observation.stage("tool", `dynamic-${n}`).end("completed");
  observation.finish("completed");
  observation.finish("failed");
  await diagnostics.flush();
  assert.ok(records.length <= 2);
  assert.equal(diagnostics.stats.activeRuns, 0);
  assert.equal(diagnostics.stats.droppedRuns, 1);
  assert.equal(diagnostics.metrics().phases.provider.progress, 20_000);
  assert.equal(diagnostics.metrics().phases.tool.count, 300);
  assert.equal(JSON.stringify(records).includes("private"), false);
  assert.equal(
    JSON.stringify(diagnostics.metrics()).includes("dynamic"),
    false,
  );
  assert.ok(diagnostics.stats.queuedBytes <= 1024);
  await diagnostics.close();
  const bounded = collecting({
    level: "steps",
    maxSpansPerRun: 2,
    includeNames: true,
  });
  const boundedRun = bounded.diagnostics.startRun(input)!;
  for (let n = 0; n < 5; n++)
    boundedRun.stage("tool", "configured-tool").end("completed");
  boundedRun.finish("completed");
  await bounded.diagnostics.flush();
  const boundedRecord = bounded.records[0] as RunDiagnostic;
  assert.equal(boundedRecord.spans.length, 2);
  assert.equal(boundedRecord.droppedSpans, 3);
  assert.equal(boundedRecord.phases.tool.count, 5);
  assert.equal(boundedRecord.spans[0]!.name, "configured-tool");
  await bounded.diagnostics.close();
  const zero = collecting({ sampleRate: 0 });
  const driver = new AgenticDriver({
    diagnostics: zero.diagnostics,
    providers: [mockProvider()],
  });
  await driver.run(base);
  await zero.diagnostics.flush();
  assert.equal(zero.records.length, 0);
  assert.equal(zero.diagnostics.metrics().runs.completed, 1);
  await zero.diagnostics.close();
});

test("summary is content-free by default; names, detailed spans and correlation need configuration", async () => {
  for (const names of [false, true]) {
    const { diagnostics, records } = collecting({ includeNames: names });
    await new AgenticDriver({ diagnostics, providers: [mockProvider()] }).run({
      ...base,
      metadata: { requestId, traceparent: traceParent },
    });
    await diagnostics.flush();
    const record = records[0] as RunDiagnostic;
    assert.equal(record.requestId, undefined);
    assert.equal(record.traceParent, undefined);
    assert.deepEqual(record.spans, []);
    assert.equal(record.provider, names ? "mock" : undefined);
    await diagnostics.close();
  }
  for (const value of [
    "private-secret",
    "00-00000000000000000000000000000000-2222222222222222-01",
    "00-11111111111111111111111111111111-0000000000000000-01",
    traceParent + "-private",
    traceParent.replace("00-", "01-"),
  ])
    assert.deepEqual(
      diagnosticCorrelation({ requestId: value, traceParent: value }),
      {},
    );
  assert.deepEqual(diagnosticCorrelation({ requestId, traceParent }), {
    requestId,
    traceParent,
  });
});

test("HTTP correlation is opt-in and host records never capture authentication or arbitrary paths", async () => {
  for (const enabled of [false, true]) {
    const { diagnostics, records } = collecting({ level: "steps" });
    const driver = new AgenticDriver({
      diagnostics,
      providers: [mockProvider()],
    });
    const token = "private-driver-token-at-least-32-characters";
    const host = await serve(driver, {
      port: 0,
      diagnosticHeaders: enabled,
      tokens: [{ token, subject: "private-subject", providers: ["mock"] }],
    });
    try {
      const client = new AgenticClient({
        url: host.url,
        token,
        fetch: (url, init) =>
          fetch(url, {
            ...init,
            headers: {
              ...Object.fromEntries(new Headers(init?.headers)),
              "AgenticDriver-Request-Id": requestId,
              traceparent: traceParent,
              baggage: "private-secret",
            },
          }),
      });
      await client.run(base);
      const rejected = await fetch(
        host.url + "/private-path?secret=private-query",
      );
      await rejected.text();
      await diagnostics.flush();
      const run = records.find((record) => record.kind === "run")!;
      assert.equal(run.requestId, enabled ? requestId : undefined);
      assert.ok(
        records.some(
          (record) =>
            record.kind === "host" &&
            record.operation === "run" &&
            record.requestId === (enabled ? requestId : undefined),
        ),
      );
      assert.ok(
        records.some(
          (record) => record.kind === "host" && record.outcome === "rejected",
        ),
      );
      assert.equal(JSON.stringify(records).includes("private"), false);
    } finally {
      await host.close();
      await diagnostics.close();
    }
  }
});

test("queue, cancellation, replay and durable waiting have distinct observations", async () => {
  const { diagnostics, records } = collecting({ level: "steps" });
  let started!: () => void, resume!: () => void;
  const begun = new Promise<void>((resolve) => {
      started = resolve;
    }),
    pending = new Promise<void>((resolve) => {
      resume = resolve;
    });
  let calls = 0;
  const driver = new AgenticDriver({
    diagnostics,
    operations: new MemoryOperationStore(),
    scheduling: { total: 1, perSubject: 1, queue: { total: 1, perSubject: 1 } },
    providers: [
      mockProvider(async () => {
        calls++;
        if (calls === 1) {
          started();
          await pending;
        }
        return { text: "ok" };
      }),
    ],
  });
  const first = driver.run(base);
  await begun;
  const controller = new AbortController();
  const second = driver.run(base, { signal: controller.signal });
  await immediate();
  controller.abort();
  await assert.rejects(second, { code: "CANCELLED" });
  resume();
  await first;
  const saved = await driver.run({ ...base, idempotencyKey: "replay" });
  const replay = await driver.run({ ...base, idempotencyKey: "replay" });
  assert.equal(saved.runId, replay.runId);
  assert.equal(calls, 2);
  await driver.run(base, { diagnosticQueuedAt: Date.now() - 10000 });
  await diagnostics.flush();
  const runs = records.filter(
    (record): record is RunDiagnostic => record.kind === "run",
  );
  assert.equal(
    runs.find((record) => record.outcome === "cancelled")!.phases.provider
      .count,
    0,
  );
  assert.equal(
    runs.find((record) => record.outcome === "replayed")!.phases.provider.count,
    0,
  );
  assert.equal(runs.filter((record) => record.runId === saved.runId).length, 2);
  assert.ok(runs.at(-1)!.phases.queue.durationMs >= 10000);
  assert.equal(diagnostics.stats.activeRuns, 0);
  await diagnostics.close();
});

test("provider failures and abandoned replay finish once without retaining diagnostics", async () => {
  const { diagnostics, records } = collecting({ level: "steps" });
  const failing = new AgenticDriver({
    diagnostics,
    providers: [
      mockProvider(() => {
        throw new Error("private-provider-error");
      }),
    ],
  });
  await assert.rejects(failing.run(base));
  const driver = new AgenticDriver({
    diagnostics,
    providers: [mockProvider()],
    operations: new MemoryOperationStore(),
  });
  await driver.run({ ...base, idempotencyKey: "partial-replay" });
  const replay = driver.stream({ ...base, idempotencyKey: "partial-replay" });
  assert.equal((await replay.next()).value!.type, "run.started");
  await replay.return(undefined);
  await diagnostics.flush();
  const runs = records.filter(
    (record): record is RunDiagnostic => record.kind === "run",
  );
  assert.equal(runs.length, 3);
  assert.deepEqual(
    runs.map((record) => record.outcome),
    ["failed", "completed", "cancelled"],
  );
  assert.equal(
    runs[0]!.spans.find((span) => span.phase === "provider")!.outcome,
    "failed",
  );
  assert.equal(diagnostics.stats.activeRuns, 0);
  assert.equal(JSON.stringify(records).includes("private"), false);
  await diagnostics.close();
});
