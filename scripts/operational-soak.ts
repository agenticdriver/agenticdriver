/** Count-driven, synthetic host qualification. No real provider or model calls. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import {
  setImmediate as immediate,
  setTimeout as delay,
} from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AgenticClient } from "../src/client.js";
import { Diagnostics } from "../src/diagnostics.js";
import { AgenticDriver } from "../src/driver.js";
import { abortable } from "../src/errors.js";
import { mockProvider } from "../src/providers/mock.js";
import { serve } from "../src/server.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const { values } = parseArgs({
  options: {
    cycles: { type: "string", default: "20" },
    batches: { type: "string", default: "20" },
    output: { type: "string" },
  },
});
function integer(value: string, name: string, min: number, max: number) {
  assert.match(value, /^[1-9][0-9]*$/, `${name} must be an integer`);
  const number = Number(value);
  assert.ok(number >= min && number <= max, `${name} must be ${min}..${max}`);
  return number;
}
const cycles = integer(values.cycles!, "cycles", 3, 500);
const batches = integer(values.batches!, "batches", 1, 100);
assert.ok(
  global.gc,
  "Run Node with --expose-gc for retained-heap measurements",
);
assert.ok(values.output, "Specify a new --output receipt file");
// Reserve the receipt before doing work; refuse symlinks/existing results.
const output = await open(resolve(values.output), "wx", 0o600);
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const source = {
  commit: git("rev-parse", "HEAD"),
  dirty: git("status", "--porcelain").length > 0,
};
const startedAt = new Date().toISOString(),
  started = performance.now();
const workload = {
  cycles,
  batchesPerCycle: batches,
  warmupCycles: 2,
  subjects: 8,
  streamsPerBatch: 16,
  maxActive: 8,
  maxQueued: 32,
  maxActivePerSubject: 1,
  inputCharacters: 16384,
  outputCharacters: 8192,
  chunksPerStream: 16,
  providerChunkDelayMs: 2,
};
const thresholds = {
  retainedHeapGrowthBytes: 8 * 1024 ** 2,
  rssGrowthBytes: 256 * 1024 ** 2,
};
const counters = {
  completedStreams: 0,
  cancelledStreams: 0,
  queueRejections: 0,
  providerStarts: 0,
  providerFinishes: 0,
  providerPeak: 0,
  exportedDiagnostics: 0,
  streamedCharacters: 0,
};
const subjects = Array.from(
  { length: workload.subjects },
  (_, index) => `soak-subject-${index}`,
);
const running = new Map<string, number>();
const completedBySubject = new Map(subjects.map((subject) => [subject, 0]));
let providerActive = 0;
let gate: { promise: Promise<void>; release: () => void } | undefined;
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const supervisor = new AbortController();
// Only a failed test harness watchdog, never an SDK run/inactivity setting.
const watchdog = setTimeout(() => supervisor.abort(), 20 * 60 * 1000);
const diagnostics = new Diagnostics({
  level: "steps",
  maxActiveRuns: 64,
  queueSize: 256,
  maxQueueBytes: 1_000_000,
  batchSize: 32,
  exporter: {
    export(records) {
      counters.exportedDiagnostics += records.length;
    },
  },
});
const expected = (subject: string) =>
  `${subject}:` + "x".repeat(workload.outputCharacters - subject.length - 1);
const provider = mockProvider(async (request, context) => {
  const [mode, subject] = request.messages.at(-1)!.content.split("|", 3);
  assert.equal(
    context.subject,
    subject,
    "Authenticated subject crossed fixture request identity",
  );
  assert.ok(subjects.includes(subject!));
  counters.providerStarts++;
  providerActive++;
  counters.providerPeak = Math.max(counters.providerPeak, providerActive);
  running.set(context.subject, (running.get(context.subject) ?? 0) + 1);
  try {
    assert.ok(providerActive <= workload.maxActive);
    assert.equal(
      running.get(context.subject),
      1,
      "Per-subject concurrency exceeded",
    );
    if (mode === "hold") {
      assert.ok(gate);
      await abortable(gate.promise, context.signal);
    }
    const text = expected(context.subject);
    for (
      let offset = 0;
      offset < text.length;
      offset += text.length / workload.chunksPerStream
    ) {
      await delay(workload.providerChunkDelayMs, undefined, {
        signal: context.signal,
      });
      context.emitText(
        text.slice(offset, offset + text.length / workload.chunksPerStream),
      );
    }
    completedBySubject.set(
      context.subject,
      completedBySubject.get(context.subject)! + 1,
    );
    return { text, usage: { inputTokens: 0, outputTokens: 0 } };
  } finally {
    counters.providerFinishes++;
    providerActive--;
    const remaining = running.get(context.subject)! - 1;
    if (remaining) running.set(context.subject, remaining);
    else running.delete(context.subject);
  }
});
provider.info.capabilities.textStreaming = true;
const driver = new AgenticDriver({
  diagnostics,
  providers: [provider],
  scheduling: {
    total: workload.maxActive,
    perSubject: 1,
    queue: { total: workload.maxQueued, perSubject: 4 },
  },
});
let host: Awaited<ReturnType<typeof serve>> | undefined;
let clients: AgenticClient[] = [];
const checkpoints: Array<{
  cycle: number;
  heapUsed: number;
  rss: number;
  external: number;
  arrayBuffers: number;
}> = [];
const base = { provider: "mock", model: "demo" };
function input(index: number, mode: string) {
  const prefix = `${mode}|${subjects[index]}|`;
  return prefix + "f".repeat(workload.inputCharacters - prefix.length);
}
function stream(index: number, mode = "normal") {
  const stop = new AbortController();
  const task = (async () => {
    let sequence = 0,
      text = "",
      terminal = false,
      runId: string | undefined;
    try {
      for await (const event of clients[index]!.stream(
        { ...base, input: input(index, mode) },
        {
          signal: AbortSignal.any([stop.signal, supervisor.signal]),
        },
      )) {
        assert.equal(terminal, false, "Event after terminal");
        assert.equal(event.sequence, ++sequence);
        runId ??= event.runId;
        assert.equal(event.runId, runId);
        if (event.type === "text.delta") text += event.text;
        assert.ok(text.length <= workload.outputCharacters);
        if (event.type === "run.completed") {
          assert.equal(event.result.text, expected(subjects[index]!));
          assert.equal(text, event.result.text);
          terminal = true;
        } else if (
          event.type === "run.failed" ||
          event.type === "run.cancelled"
        ) {
          throw Object.assign(new Error("Synthetic stream failed"), {
            code: event.error.code,
          });
        }
      }
      assert.equal(terminal, true, "Missing terminal event");
      counters.completedStreams++;
      counters.streamedCharacters += text.length;
      return "completed";
    } catch (error) {
      const interrupted =
        (error as { code?: string }).code === "CANCELLED" ||
        (error as Error).name === "AbortError";
      if (!stop.signal.aborted || !interrupted || supervisor.signal.aborted)
        throw error;
      counters.cancelledStreams++;
      return "cancelled";
    }
  })();
  // Attach a rejection observer immediately; a phase may inspect this later.
  void task.catch(() => {});
  return { stop, task };
}
async function waitFor(predicate: () => boolean) {
  const start = performance.now();
  while (!predicate()) {
    supervisor.signal.throwIfAborted();
    assert.ok(
      performance.now() - start < 10000,
      "Synthetic fixture failed to reach its expected state",
    );
    await delay(5);
  }
}
async function settled() {
  await waitFor(
    () =>
      driver.scheduler!.stats.active === 0 &&
      driver.scheduler!.stats.queued === 0 &&
      providerActive === 0 &&
      diagnostics.stats.activeRuns === 0,
  );
  await diagnostics.flush();
  assert.equal(running.size, 0);
  assert.equal(counters.providerStarts, counters.providerFinishes);
  assert.equal(diagnostics.stats.queuedRecords, 0);
  assert.equal(diagnostics.stats.queuedBytes, 0);
  assert.equal(diagnostics.stats.droppedRuns, 0);
  assert.equal(diagnostics.stats.droppedRecords, 0);
  assert.equal(diagnostics.stats.exportFailures, 0);
}
async function saturation() {
  gate = deferred();
  const active = subjects.map((_, index) => stream(index, "hold"));
  const queued: ReturnType<typeof stream>[] = [];
  try {
    await waitFor(() => providerActive === 8);
    for (let round = 0; round < 4; round++)
      queued.push(...subjects.map((_, index) => stream(index, "hold")));
    await waitFor(() => driver.scheduler!.stats.queued === 32);
    await assert.rejects(
      clients[0]!.run(
        { ...base, input: input(0, "hold") },
        { signal: supervisor.signal },
      ),
      { code: "QUEUE_FULL", retryable: true },
    );
    counters.queueRejections++;
    for (const item of queued.slice(0, 8)) item.stop.abort();
    assert.deepEqual(
      await Promise.all(queued.slice(0, 8).map((item) => item.task)),
      Array(8).fill("cancelled"),
    );
    await waitFor(() => driver.scheduler!.stats.queued === 24);
    for (const item of active.slice(0, 4)) item.stop.abort();
    assert.deepEqual(
      await Promise.all(active.slice(0, 4).map((item) => item.task)),
      Array(4).fill("cancelled"),
    );
    await waitFor(
      () => providerActive === 8 && driver.scheduler!.stats.queued === 20,
    );
    gate.release();
    const remaining = [...active.slice(4), ...queued.slice(8)];
    assert.deepEqual(
      await Promise.all(remaining.map((item) => item.task)),
      Array(28).fill("completed"),
    );
    await settled();
  } finally {
    gate.release();
    for (const item of [...active, ...queued]) item.stop.abort();
    await Promise.allSettled([...active, ...queued].map((item) => item.task));
    gate = undefined;
  }
}
async function cycle() {
  await saturation();
  for (let batch = 0; batch < batches; batch++) {
    supervisor.signal.throwIfAborted();
    const tasks = Array.from({ length: workload.streamsPerBatch }, (_, index) =>
      stream(index % subjects.length),
    );
    try {
      assert.deepEqual(
        await Promise.all(tasks.map((item) => item.task)),
        Array(workload.streamsPerBatch).fill("completed"),
      );
    } finally {
      for (const item of tasks) item.stop.abort();
      await Promise.allSettled(tasks.map((item) => item.task));
    }
    await settled();
  }
}
async function memory(cycle: number) {
  global.gc!();
  await immediate();
  global.gc!();
  const { heapUsed, rss, external, arrayBuffers } = process.memoryUsage();
  const sample = { cycle, heapUsed, rss, external, arrayBuffers };
  checkpoints.push(sample);
  if (cycle > 0) {
    assert.ok(
      heapUsed - checkpoints[0]!.heapUsed <= thresholds.retainedHeapGrowthBytes,
      "Retained heap exceeded the workload growth gate",
    );
    assert.ok(
      rss - checkpoints[0]!.rss <= thresholds.rssGrowthBytes,
      "Resident memory exceeded the workload growth gate",
    );
  }
}
let outcome = "failed";
try {
  const tokens = subjects.map((subject) => ({
    subject,
    token: randomBytes(32).toString("hex"),
    providers: ["mock"],
  }));
  host = await serve(driver, { port: 0, tokens });
  clients = tokens.map(
    ({ token }) => new AgenticClient({ url: host!.url, token }),
  );
  for (let warmup = 0; warmup < workload.warmupCycles; warmup++) await cycle();
  await memory(0);
  for (let index = 1; index <= cycles; index++) {
    await cycle();
    await memory(index);
    console.log(
      JSON.stringify({
        cycle: index,
        cycles,
        completedStreams: counters.completedStreams,
        heapMiB: Math.round(checkpoints.at(-1)!.heapUsed / 1024 ** 2),
      }),
    );
  }
  assert.ok([...completedBySubject.values()].every((count) => count > 0));
  const totalCycles = cycles + workload.warmupCycles;
  assert.equal(
    counters.completedStreams,
    totalCycles * (28 + workload.streamsPerBatch * batches),
  );
  assert.equal(counters.cancelledStreams, totalCycles * 12);
  assert.equal(counters.queueRejections, totalCycles);
  assert.equal(
    counters.providerStarts,
    totalCycles * (32 + workload.streamsPerBatch * batches),
  );
  outcome = "passed";
} finally {
  clearTimeout(watchdog);
  supervisor.abort();
  gate?.release();
  try {
    await host?.close();
    await diagnostics.close();
    assert.deepEqual(driver.scheduler!.stats, { active: 0, queued: 0 });
    assert.equal(providerActive, 0);
  } catch (error) {
    outcome = "failed";
    throw error;
  } finally {
    const report = {
      schema: "agenticdriver.operational-soak.v1",
      outcome,
      source,
      startedAt,
      durationMs: Math.round(performance.now() - started),
      runtime: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
      },
      workload,
      thresholds,
      counters,
      checkpoints,
      final: {
        scheduler: driver.scheduler!.stats,
        providerActive,
        diagnostics: diagnostics.stats,
      },
      modelCalls: 0,
      syntheticOnly: true,
      transport: "authenticated-loopback-http",
      limitations: [
        "Combined fixture client/server process measurements",
        "No real model latency or billing",
        "No native OS isolation qualification",
        "No process restart or production workload qualification",
      ],
    };
    await output.writeFile(JSON.stringify(report, null, 2) + "\n");
    await output.close();
  }
}
