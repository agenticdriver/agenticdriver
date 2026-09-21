import assert from "node:assert/strict";
import { mkdtemp, rm, chmod, symlink, readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { AgenticDriver, type DriverOptions } from "../src/driver.js";
import { AgenticClient } from "../src/client.js";
import {
  JobService,
  SqliteJobStore,
  type JobPrincipal,
  type JobStoreOptions,
} from "../src/jobs.js";
import { mockProvider } from "../src/providers/mock.js";
import { serve } from "../src/server.js";
import { DatabaseSync } from "node:sqlite";
import {
  configuredServer,
  configuredDriver,
  validateHostConfig,
} from "../src/host.js";
import { newOperation, operationKey } from "../src/operations.js";
import { MemoryContextStore } from "../src/context.js";
import {
  RetrievalService,
  MemoryVectorStore,
  DeterministicEmbeddingAdapter,
} from "../src/retrieval.js";

const base = { provider: "mock", model: "demo", input: "synthetic job" };
const token = "durable-job-fixture-token-32-characters";
const alice: JobPrincipal = {
  subject: "alice",
  providers: ["mock"],
  tools: ["write"],
  jobs: ["submit", "read", "cancel"],
  retrieval: ["library"],
};
const driver = (options: Partial<DriverOptions> = {}) =>
  new AgenticDriver({
    providers: [mockProvider()],
    usage: { hostId: "job-host", accounts: { mock: "synthetic" } },
    ...options,
  });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until<T>(
  get: () => Promise<T>,
  accept: (value: T) => boolean,
): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const value = await get();
    if (accept(value)) return value;
    await delay(10);
  }
  throw new Error("Fixture did not reach expected state");
}
async function setup(t: TestContext, options: Partial<JobStoreOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "agenticdriver-jobs-"));
  const path = join(directory, "jobs.db");
  const store = await SqliteJobStore.open(path, {
    retentionMs: 60_000,
    ...options,
  });
  const cleanup: (() => Promise<unknown>)[] = [];
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, path, store, cleanup };
}
const proposed = (key: string, subject = "alice") => ({
  request: base,
  subject,
  principal: "alice-token",
  account: { hostId: "job-host", accountId: "synthetic" },
  keyHash: operationKey(subject, key),
  fingerprint: newOperation(base, "unused").fingerprint,
});

test("an actual process crash preserves completed jobs and tool effects while queued work survives", async (t) => {
  const { store, path, directory, cleanup } = await setup(t);
  const completed = await store.submit(proposed("before-crash"));
  const effectRequest = { ...base, tools: ["write"] };
  const interrupted = await store.submit({
    ...proposed("during-crash"),
    request: effectRequest,
    fingerprint: newOperation(effectRequest, "unused").fingerprint,
  });
  const queued = await store.submit(proposed("after-crash"));
  const effectPath = join(directory, "synthetic-effects.txt");
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("./jobs-crash-child.ts", import.meta.url)),
      path,
      effectPath,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "",
    errors = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    errors += chunk.toString();
  });
  const exited = once(child, "exit");
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await exited;
  });
  await until(
    async () => {
      if (child.exitCode !== null) throw new Error(errors);
      return output;
    },
    (value) => value.includes("effect-persisted"),
  );
  child.kill("SIGKILL");
  await exited;
  let calls = 0;
  let service: JobService | undefined;
  await until(async () => {
    try {
      service = await JobService.open(
        driver({
          providers: [
            mockProvider(() => {
              calls++;
              return { text: "after restart" };
            }),
          ],
        }),
        {
          store,
          pollIntervalMs: 10,
          resolvePrincipal: () => alice,
        },
      );
      return true;
    } catch (error) {
      if ((error as { code?: string }).code === "JOB_WORKER_BUSY") return false;
      throw error;
    }
  }, Boolean);
  cleanup.push(() => service!.close());
  await until(
    () => service!.read({ id: queued.info.id }, "alice-token"),
    (job) => job.state === "completed",
  );
  assert.equal(
    (await service!.read({ id: completed.info.id }, "alice-token")).state,
    "completed",
  );
  assert.equal(
    (await service!.read({ id: interrupted.info.id }, "alice-token")).state,
    "interrupted",
  );
  assert.equal(calls, 1);
  assert.equal(await readFile(effectPath, "utf8"), "one\n");
});

test("configured job storage opens only on serve and remains readable after host-owned store reopen", async (t) => {
  const { directory } = await setup(t);
  const path = join(directory, "configured.sqlite");
  const config = validateHostConfig({
    version: 1,
    listen: { host: "127.0.0.1", port: 0 },
    usage: { hostId: "job-host" },
    providers: [
      { id: "mock", kind: "mock", models: ["demo"], accountId: "synthetic" },
    ],
    tokens: [
      {
        id: "app",
        subject: "alice",
        tokenRef: { env: "FIXTURE_TOKEN" },
        providers: ["mock"],
        jobs: ["submit", "read", "cancel"],
      },
    ],
    jobs: {
      path: "configured.sqlite",
      retentionMs: 60_000,
      worker: { pollIntervalMs: 10 },
    },
  });
  const configPath = join(directory, "config.json");
  const options = await configuredServer(config, configPath, async () => token);
  await assert.rejects(stat(path), { code: "ENOENT" });
  const host = await serve(configuredDriver(config, configPath), options);
  let job;
  try {
    job = await new AgenticClient({ url: host.url, token }).submitJob({
      key: "configured",
      request: base,
    });
  } finally {
    await host.close();
  }
  const reopened = await SqliteJobStore.open(path, { retentionMs: 60_000 });
  try {
    assert.equal((await reopened.read("alice", job.id)).info.id, job.id);
  } finally {
    await reopened.close();
  }
});

test("a failed listener does not claim or run queued jobs", async (t) => {
  const { store, cleanup } = await setup(t);
  const host = await serve(driver(), {
    port: 0,
    tokens: [{ token, subject: "alice", providers: ["mock"] }],
  });
  cleanup.push(() => host.close());
  const queued = await store.submit(proposed("bind-failure"));
  await assert.rejects(
    serve(driver(), {
      port: Number(new URL(host.url).port),
      jobs: { store },
      tokens: [
        {
          token,
          subject: "alice",
          providers: ["mock"],
          jobs: ["submit", "read", "cancel"],
        },
      ],
    }),
    { code: "EADDRINUSE" },
  );
  assert.equal(
    (await store.read("alice", queued.info.id)).info.state,
    "queued",
  );
  await store.acquire("probe", 1000);
  await store.release("probe");
});

test("detached HTTP jobs survive client cancellation, replay ordered pages and isolate tenants and grants", async (t) => {
  const { store, cleanup } = await setup(t);
  const started = deferred<void>(),
    finish = deferred<void>();
  let calls = 0;
  const host = await serve(
    driver({
      providers: [
        mockProvider(async (_, context) => {
          calls++;
          context.emitText("hello");
          started.resolve();
          await finish.promise;
          return { text: "hello world" };
        }),
      ],
    }),
    {
      port: 0,
      jobs: { store, pollIntervalMs: 10 },
      tokens: [
        { token, ...alice },
        { token: token + "bob", ...alice, subject: "bob" },
        { token: token + "limited", ...alice, providers: [] },
        { token: token + "none", ...alice, jobs: [] },
      ].map((entry) => ({ ...entry, retrieval: { search: ["library"] } })),
    },
  );
  cleanup.push(() => host.close());
  const client = new AgenticClient({ url: host.url, token });
  assert.ok((await client.protocol()).features.includes("durable-jobs"));
  const cancelTransport = new AbortController();
  const job = await client.submitJob(
    { key: "one", request: base },
    { signal: cancelTransport.signal },
  );
  cancelTransport.abort();
  await started.promise;
  const same = await client.submitJob({ key: "one", request: base });
  assert.equal(same.id, job.id);
  await assert.rejects(
    client.submitJob({ key: "one", request: { ...base, input: "changed" } }),
    { code: "IDEMPOTENCY_CONFLICT" },
  );
  for (const [suffix, code] of [
    ["bob", "JOB_NOT_FOUND"],
    ["limited", "FORBIDDEN"],
    ["none", "FORBIDDEN"],
  ]) {
    const other = new AgenticClient({ url: host.url, token: token + suffix });
    await assert.rejects(other.readJob({ id: job.id }), { code });
    await assert.rejects(other.cancelJob({ id: job.id }), { code });
    await assert.rejects(other.jobEvents({ id: job.id, after: 0 }), { code });
  }
  assert.equal((await client.readJob({ id: job.id })).state, "running");
  finish.resolve();
  const completed = await until(
    () => client.readJob({ id: job.id }),
    (job) => job.state === "completed",
  );
  let cursor = 0;
  const events = [];
  do {
    const page = await client.jobEvents({
      id: job.id,
      after: cursor,
      limit: 2,
    });
    events.push(...page.events);
    cursor = page.nextCursor;
    assert.equal(page.hasMore, cursor < completed.cursor);
  } while (cursor < completed.cursor);
  assert.deepEqual(
    events.map((event) => event.sequence),
    events.map((_, i) => i + 1),
  );
  assert.equal(events.at(-1)?.type, "run.completed");
  assert.equal(calls, 1);
  assert.equal((await client.cancelJob({ id: job.id })).state, "completed");
  assert.equal(
    (await client.jobEvents({ id: job.id, after: cursor })).events.length,
    0,
  );
  await assert.rejects(client.jobEvents({ id: job.id, after: cursor + 1 }), {
    code: "INVALID_JOB_CURSOR",
  });
});

test("shutdown preserves queued jobs and interrupts started work without repeating a completed tool effect", async (t) => {
  const { store, cleanup } = await setup(t);
  let effects = 0,
    calls = 0;
  const waiting = deferred<void>();
  const runtime = driver({
    scheduling: { total: 1, queue: { total: 8, perSubject: 8 } },
    tools: [
      {
        name: "write",
        description: "synthetic side effect",
        inputSchema: { type: "object" },
        execute: () => ({ count: ++effects }),
      },
    ],
    providers: [
      mockProvider(async (request) => {
        calls++;
        if (!request.tools.length) return { text: "queued survived" };
        if (!request.messages.some((message) => message.role === "tool"))
          return {
            text: "",
            toolCalls: [{ id: "effect-one", name: "write", arguments: {} }],
          };
        await waiting.promise;
        return { text: "after tool" };
      }),
    ],
  });
  let service = await JobService.open(runtime, {
    store,
    pollIntervalMs: 10,
    resolvePrincipal: () => alice,
  });
  cleanup.push(async () => {
    waiting.resolve();
    await service.close();
  });
  const first = await service.submit(
    { key: "effect", request: { ...base, tools: ["write"] } },
    "alice-token",
  );
  await until(
    () => service.events({ id: first.id, after: 0 }, "alice-token"),
    (page) => page.events.some((event) => event.type === "tool.completed"),
  );
  const second = await service.submit(
    { key: "later", request: base },
    "alice-token",
  );
  assert.equal(
    (await service.read({ id: second.id }, "alice-token")).state,
    "queued",
  );
  await service.close();
  assert.equal((await store.read("alice", first.id)).info.state, "interrupted");
  assert.equal((await store.read("alice", second.id)).info.state, "queued");
  service = await JobService.open(runtime, {
    store,
    pollIntervalMs: 10,
    resolvePrincipal: () => alice,
  });
  await until(
    () => service.read({ id: second.id }, "alice-token"),
    (job) => job.state === "completed",
  );
  const replay = await service.events(
    { id: first.id, after: 0 },
    "alice-token",
  );
  const last = replay.events.at(-1)!;
  assert.equal(last.type, "run.failed");
  if (last.type === "run.failed") assert.equal(last.error.outcome, "uncertain");
  assert.equal(effects, 1);
  assert.equal(calls, 3);
  assert.equal(
    (
      await service.submit(
        { key: "effect", request: { ...base, tools: ["write"] } },
        "alice-token",
      )
    ).state,
    "interrupted",
  );
});

test("durable dispatch shares foreground caps and skips a blocked subject with one worker slot", async (t) => {
  const { store, cleanup } = await setup(t);
  const runtime = driver({
    scheduling: { total: 2, perSubject: 1, queue: { total: 8, perSubject: 4 } },
  });
  const held = runtime.scheduler!.submit(
    { subject: "alice" },
    new AbortController().signal,
  );
  await held.wait();
  const service = await JobService.open(runtime, {
    store,
    pollIntervalMs: 10,
    maxWorkers: 1,
    resolvePrincipal: (id) => ({ ...alice, subject: id }),
  });
  cleanup.push(async () => {
    held.release();
    await service.close();
  });
  const blocked = await service.submit(
    { key: "blocked", request: base },
    "alice",
  );
  const eligible = await service.submit(
    { key: "eligible", request: base },
    "bob",
  );
  await until(
    () => service.read({ id: eligible.id }, "bob"),
    (job) => job.state === "completed",
  );
  assert.equal(
    (await service.read({ id: blocked.id }, "alice")).state,
    "queued",
  );
  assert.equal(runtime.scheduler!.stats.queued, 0);
  held.release();
  await until(
    () => service.read({ id: blocked.id }, "alice"),
    (job) => job.state === "completed",
  );
});

test("expired worker leases fence old writers and recover queued, completed and interrupted jobs separately", async (t) => {
  const { store, path, cleanup } = await setup(t);
  const secondStore = await SqliteJobStore.open(path, { retentionMs: 60_000 });
  cleanup.push(() => secondStore.close());
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  await store.acquire("old", 300);
  await assert.rejects(secondStore.acquire("new", 300), {
    code: "JOB_WORKER_BUSY",
  });
  const running = await store.submit(proposed("running"));
  const queued = await store.submit(proposed("queued"));
  const completed = await store.submit(proposed("completed"));
  for (const record of [running, completed]) {
    await store.start("old", record.info.id);
    await store.append("old", record.info.id, {
      type: "run.started",
      runId: record.info.runId,
      sequence: 1,
      timestamp: new Date().toISOString(),
      provider: "mock",
      model: "demo",
    });
  }
  await store.append("old", completed.info.id, {
    type: "run.completed",
    runId: completed.info.runId,
    sequence: 2,
    timestamp: new Date().toISOString(),
    result: {
      runId: completed.info.runId,
      ...base,
      text: "done",
      steps: 1,
      finishReason: "stop",
      usage: {},
    },
  });
  t.mock.timers.tick(301);
  await secondStore.acquire("new", 300);
  assert.equal(
    (await secondStore.read("alice", running.info.id)).info.state,
    "interrupted",
  );
  assert.equal(
    (await secondStore.read("alice", queued.info.id)).info.state,
    "queued",
  );
  assert.equal(
    (await secondStore.read("alice", completed.info.id)).info.state,
    "completed",
  );
  await assert.rejects(store.renew("old", 300), { code: "JOB_LEASE_LOST" });
  await assert.rejects(store.start("old", queued.info.id), {
    code: "JOB_LEASE_LOST",
  });
  assert.equal(await secondStore.start("new", running.info.id), false);
  await secondStore.release("new");
});

test("queued work rechecks revoked permissions and changed account bindings after restart", async (t) => {
  const { store, cleanup } = await setup(t);
  let calls = 0;
  const one = await store.submit(proposed("revoked"));
  const service = await JobService.open(
    driver({
      providers: [
        mockProvider(() => {
          calls++;
          return { text: "unexpected" };
        }),
      ],
    }),
    {
      store,
      pollIntervalMs: 10,
      resolvePrincipal: () => undefined,
    },
  );
  await until(
    () => store.read("alice", one.info.id),
    (record) => record.info.state === "failed",
  );
  await service.close();
  const two = await store.submit(proposed("rebound"));
  const replacement = await JobService.open(
    driver({
      usage: { hostId: "job-host", accounts: { mock: "different" } },
      providers: [
        mockProvider(() => {
          calls++;
          return { text: "unexpected" };
        }),
      ],
    }),
    {
      store,
      pollIntervalMs: 10,
      resolvePrincipal: () => alice,
    },
  );
  cleanup.push(() => replacement.close());
  const record = await until(
    () => store.read("alice", two.info.id),
    (record) => record.info.state === "failed",
  );
  const last = record.events.at(-1)!;
  assert.equal(
    last.type === "run.failed" && last.error.code,
    "JOB_ACCOUNT_CHANGED",
  );
  assert.equal(calls, 0);
});

test("explicit cancellation works for queued and running jobs without introducing a default deadline", async (t) => {
  const { store, cleanup } = await setup(t);
  let calls = 0;
  const runtime = driver({
    scheduling: { total: 1 },
    providers: [
      mockProvider(async () => {
        calls++;
        await new Promise(() => {});
        return { text: "never" };
      }),
    ],
  });
  const service = await JobService.open(runtime, {
    store,
    leaseMs: 300,
    pollIntervalMs: 10,
    resolvePrincipal: () => alice,
  });
  cleanup.push(() => service.close());
  const one = await service.submit(
    { key: "running", request: base },
    "alice-token",
  );
  await until(
    () => service.read({ id: one.id }, "alice-token"),
    (job) => job.cursor >= 2,
  );
  const two = await service.submit(
    { key: "queued", request: base },
    "alice-token",
  );
  await delay(400); // Multiple lease renewals are independent of absent model progress.
  assert.equal(
    (await service.read({ id: one.id }, "alice-token")).state,
    "running",
  );
  assert.equal(
    (await service.read({ id: two.id }, "alice-token")).state,
    "queued",
  );
  assert.equal(
    (await service.cancel({ id: two.id }, "alice-token")).state,
    "cancelled",
  );
  await service.cancel({ id: one.id }, "alice-token");
  await until(
    () => service.read({ id: one.id }, "alice-token"),
    (job) => job.state === "cancelled",
  );
  assert.equal(calls, 1);
  const idle = await service.submit(
    { key: "idle", request: { ...base, idleTimeoutMs: 25 } },
    "alice-token",
  );
  await until(
    () => service.read({ id: idle.id }, "alice-token"),
    (job) => job.state === "cancelled",
  );
  const last = (
    await service.events({ id: idle.id, after: 0 }, "alice-token")
  ).events.at(-1)!;
  assert.equal(
    last.type === "run.cancelled" && last.error.code,
    "IDLE_TIMEOUT",
  );
});

test("retention erases payloads but preserves accepted keys and enforces tombstone capacities", async (t) => {
  const { store, path } = await setup(t, { retentionMs: 1000, maxJobs: 1 });
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const job = await store.submit(proposed("one"));
  await store.cancel("alice", job.info.id);
  t.mock.timers.tick(1001);
  await assert.rejects(store.read("alice", job.info.id), {
    code: "JOB_EXPIRED",
  });
  const db = new DatabaseSync(path);
  try {
    assert.equal(
      db.prepare("SELECT payload FROM ad_jobs WHERE id=?").get(job.info.id)!
        .payload,
      null,
    );
  } finally {
    db.close();
  }
  await assert.rejects(store.submit(proposed("one")), { code: "JOB_EXPIRED" });
  await assert.rejects(store.submit(proposed("another")), {
    code: "JOB_STORE_FULL",
  });
  await assert.rejects(store.read("bob", job.info.id), {
    code: "JOB_NOT_FOUND",
  });
});

test("bounded event logs retain an uncertainty barrier after a tool effect and never replay execution", async (t) => {
  const { store, cleanup } = await setup(t, { maxJobBytes: 16_384 });
  let effects = 0;
  const runtime = driver({
    tools: [
      {
        name: "write",
        description: "write",
        inputSchema: { type: "object" },
        execute: () => {
          effects++;
          return "x".repeat(17_000);
        },
      },
    ],
    providers: [
      mockProvider(() => ({
        text: "",
        toolCalls: [{ id: "write-one", name: "write", arguments: {} }],
      })),
    ],
  });
  const service = await JobService.open(runtime, {
    store,
    pollIntervalMs: 10,
    resolvePrincipal: () => alice,
  });
  cleanup.push(() => service.close());
  const job = await service.submit(
    { key: "full", request: { ...base, tools: ["write"] } },
    "alice-token",
  );
  await until(
    () => service.read({ id: job.id }, "alice-token"),
    (job) => job.state === "interrupted",
  );
  const page = await service.events({ id: job.id, after: 0 }, "alice-token");
  assert.ok(page.events.some((event) => event.type === "tool.called"));
  assert.equal(page.events.at(-1)?.type, "run.failed");
  assert.equal(effects, 1);
  assert.equal(
    (
      await service.submit(
        { key: "full", request: { ...base, tools: ["write"] } },
        "alice-token",
      )
    ).state,
    "interrupted",
  );
});

test("replaying completed reference and RAG jobs reauthorizes evidence without new inference or embeddings", async (t) => {
  const { store, cleanup } = await setup(t);
  let calls = 0;
  const context = new MemoryContextStore();
  const reference = context.put({
    attachment: {
      type: "text",
      mediaType: "text/plain",
      source: { id: "note", revision: "v1" },
      text: "private note",
    },
    subjects: ["alice"],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  let allowed = true;
  const retrieval = new RetrievalService([
    {
      id: "library",
      version: "v1",
      store: new MemoryVectorStore(),
      embedding: new DeterministicEmbeddingAdapter(8),
      authorize: () =>
        allowed ? { namespace: "alice", sources: { paper: "v1" } } : null,
    },
  ]);
  const runtime = driver({
    context: { resolve: context.resolve },
    retrieval,
    providers: [
      mockProvider(() => {
        calls++;
        return { text: "evidence" };
      }),
    ],
  });
  await runtime.indexContext(
    {
      corpus: "library",
      source: { id: "paper", revision: "v1" },
      chunks: [{ id: "p1", text: "private evidence" }],
    },
    { subject: "alice" },
  );
  const service = await JobService.open(runtime, {
    store,
    pollIntervalMs: 10,
    resolvePrincipal: () => alice,
  });
  cleanup.push(() => service.close());
  const first = await service.submit(
    { key: "reference", request: { ...base, attachments: [reference] } },
    "alice-token",
  );
  const second = await service.submit(
    {
      key: "rag",
      request: {
        ...base,
        retrieval: { corpus: "library", query: "private evidence" },
      },
    },
    "alice-token",
  );
  for (const job of [first, second]) {
    await until(
      () => service.read({ id: job.id }, "alice-token"),
      (job) => job.state === "completed",
    );
    assert.ok(
      (await service.events({ id: job.id, after: 0 }, "alice-token")).events
        .length,
    );
  }
  context.delete(reference.id);
  allowed = false;
  await assert.rejects(
    service.events({ id: first.id, after: 0 }, "alice-token"),
  );
  await assert.rejects(
    service.events({ id: second.id, after: 0 }, "alice-token"),
  );
  assert.equal(
    (await service.read({ id: second.id }, "alice-token")).state,
    "completed",
  );
  assert.equal(calls, 2);
});

test("durable storage is private, opt-in and rejects process-local execution tickets", async (t) => {
  const { store, directory, cleanup } = await setup(t);
  await assert.rejects(
    SqliteJobStore.open(join(directory, "invalid.db"), { retentionMs: 0 }),
    { code: "INVALID_JOB_CONFIG" },
  );
  const service = await JobService.open(driver(), {
    store,
    resolvePrincipal: () => alice,
  });
  cleanup.push(() => service.close());
  for (const extra of [
    { session: { id: "00000000-0000-0000-0000-000000000001", revision: 0 } },
    { idempotencyKey: "nested" },
    {
      approvals: { mode: "interactive" as const, idlePolicy: "pause" as const },
    },
  ])
    await assert.rejects(
      service.submit(
        { key: "unsupported", request: { ...base, ...extra } },
        "alice-token",
      ),
      { code: "JOB_REQUEST_UNSUPPORTED" },
    );
  if (process.platform !== "win32") {
    await symlink(join(directory, "jobs.db"), join(directory, "linked.db"));
    await assert.rejects(
      SqliteJobStore.open(join(directory, "linked.db"), { retentionMs: 1000 }),
    );
    await chmod(directory, 0o755);
    await assert.rejects(
      SqliteJobStore.open(join(directory, "unsafe.db"), { retentionMs: 1000 }),
      { code: "JOB_STORAGE_UNSAFE" },
    );
    await chmod(directory, 0o700);
  }
});
