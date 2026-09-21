import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as immediate } from "node:timers/promises";
import { FairScheduler } from "../src/scheduling.js";
import { AgenticDriver } from "../src/driver.js";
import { AgenticClient } from "../src/client.js";
import { mockProvider } from "../src/providers/mock.js";
import { MemoryOperationStore } from "../src/operations.js";
import { serve } from "../src/server.js";
import type { RunEvent } from "../src/types.js";

const signal = () => new AbortController().signal;
const base = { provider: "mock", model: "demo", input: "hello" };
const token = "scheduling-fixture-token-at-least-32-characters";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function finish(events: AsyncGenerator<RunEvent>) {
  const all: RunEvent[] = [];
  for await (const event of events) all.push(event);
  return all.at(-1)!;
}

test("fair admission rotates subjects despite an earlier tenant backlog and new arrivals", async () => {
  const scheduler = new FairScheduler({
    total: 1,
    perSubject: 1,
    queue: { total: 12, perSubject: 8 },
  });
  const occupied = scheduler.submit({ subject: "alice" }, signal());
  await occupied.wait();
  const order: string[] = [];
  const enqueue = (subject: string, label: string) => {
    const ticket = scheduler.submit({ subject }, signal());
    const admitted = ticket.wait().then(() => {
      order.push(label);
    });
    return { ticket, admitted };
  };
  const a1 = enqueue("alice", "a1"),
    a2 = enqueue("alice", "a2"),
    a3 = enqueue("alice", "a3");
  const b1 = enqueue("bob", "b1"),
    b2 = enqueue("bob", "b2");
  occupied.release();
  await a1.admitted;
  const a4 = enqueue("alice", "a4");
  a1.ticket.release();
  await b1.admitted;
  b1.ticket.release();
  await a2.admitted;
  a2.ticket.release();
  await b2.admitted;
  b2.ticket.release();
  await a3.admitted;
  a3.ticket.release();
  await a4.admitted;
  a4.ticket.release();
  assert.deepEqual(order, ["a1", "b1", "a2", "b2", "a3", "a4"]);
  assert.deepEqual(scheduler.stats, { active: 0, queued: 0 });
});

test("account limits span provider aliases and subjects while blocked accounts do not stall others", async () => {
  const scheduler = new FairScheduler({
    total: 3,
    perSubject: 2,
    perAccount: 1,
    queue: { total: 8, perSubject: 4 },
  });
  const identity = {
    subject: "alice",
    hostId: "host",
    accountId: "shared",
    provider: "first",
  };
  const first = scheduler.submit(identity, signal());
  const blocked = scheduler.submit(
    { ...identity, provider: "alias", subject: "bob" },
    signal(),
  );
  const second = scheduler.submit(
    { ...identity, accountId: "other", subject: "bob" },
    signal(),
  );
  const separateHost = scheduler.submit(
    { ...identity, hostId: "other-host" },
    signal(),
  );
  await Promise.all([first.wait(), second.wait(), separateHost.wait()]);
  assert.deepEqual(scheduler.stats, { active: 3, queued: 1 });
  first.release();
  await blocked.wait();
  for (const ticket of [first, second, separateHost, blocked]) ticket.release();
  assert.deepEqual(scheduler.stats, { active: 0, queued: 0 });
  assert.throws(
    () => scheduler.submit({ subject: "alice", provider: "unbound" }, signal()),
    { code: "ADMISSION_IDENTITY_REQUIRED" },
  );
});

test("bounded queues reject saturation, cancel promptly and snapshot trusted overrides", async () => {
  const options = {
    total: 3,
    perSubject: 1,
    subjects: { alice: 2 },
    accounts: { shared: 1 },
    queue: { total: 2, perSubject: 1 },
  };
  const scheduler = new FairScheduler(options);
  options.subjects.alice = 99;
  const first = scheduler.submit({ subject: "alice" }, signal());
  const second = scheduler.submit({ subject: "alice" }, signal());
  const cancel = new AbortController();
  const waiting = scheduler.submit({ subject: "alice" }, cancel.signal);
  assert.throws(() => scheduler.submit({ subject: "alice" }, signal()), {
    code: "QUEUE_FULL",
    retryable: true,
  });
  const bob = scheduler.submit({ subject: "bob" }, signal());
  const queuedBob = scheduler.submit({ subject: "bob" }, signal());
  assert.throws(() => scheduler.submit({ subject: "carol" }, signal()), {
    code: "QUEUE_FULL",
  });
  assert.deepEqual(scheduler.stats, { active: 3, queued: 2 });
  cancel.abort();
  await assert.rejects(waiting.wait(), { code: "CANCELLED" });
  assert.deepEqual(scheduler.stats, { active: 3, queued: 1 });
  queuedBob.release();
  await assert.rejects(queuedBob.wait(), { code: "CANCELLED" });
  for (const ticket of [first, second, bob, waiting]) {
    ticket.release();
    ticket.release();
  }
  assert.deepEqual(scheduler.stats, { active: 0, queued: 0 });
});

test("queue waiting has no implicit deadline and does not start an explicit model inactivity timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let calls = 0;
  const driver = new AgenticDriver({
    providers: [mockProvider(() => ({ text: String(++calls) }))],
    scheduling: { total: 1, queue: { total: 4, perSubject: 2 } },
  });
  const held = driver.scheduler!.submit({ subject: "occupier" }, signal());
  const events = driver.stream(
    { ...base, idleTimeoutMs: 10 },
    { subject: "alice" },
  );
  assert.equal((await events.next()).value?.type, "run.started");
  const result = finish(events);
  await immediate();
  t.mock.timers.tick(30 * 86_400_000);
  await immediate();
  assert.equal(calls, 0);
  assert.deepEqual(driver.scheduler!.stats, { active: 1, queued: 1 });
  held.release();
  assert.equal((await result).type, "run.completed");
  assert.equal(calls, 1);
  assert.deepEqual(driver.scheduler!.stats, { active: 0, queued: 0 });
});

test("cancelling a paused queued stream frees its queue entry and session without inference", async () => {
  let calls = 0;
  const driver = new AgenticDriver({
    providers: [mockProvider(() => ({ text: String(++calls) }))],
    scheduling: { total: 1, queue: { total: 2, perSubject: 1 } },
    sessions: { retentionMs: 60_000 },
    usage: { hostId: "host", accounts: { mock: "shared" } },
  });
  const session = driver.createSession({
    provider: "mock",
    model: "demo",
    mode: "history",
  });
  const held = driver.scheduler!.submit({ subject: "occupier" }, signal());
  const controller = new AbortController();
  const events = driver.stream(
    { ...base, session: { id: session.session.id, revision: 0 } },
    { signal: controller.signal },
  );
  assert.equal((await events.next()).value?.type, "run.started");
  controller.abort();
  assert.equal(driver.scheduler!.stats.queued, 0);
  assert.equal(
    driver.readSession({ id: session.session.id }).session.state,
    "ready",
  );
  await events.return(undefined);
  held.release();
  assert.equal(calls, 0);
  driver.deleteSession({ id: session.session.id });
});

test("remote queued streams send headers, enforce saturation and keep control requests usable", async () => {
  const started = deferred<void>(),
    gate = deferred<void>();
  const driver = new AgenticDriver({
    providers: [
      mockProvider(async (request) => {
        if (request.messages.at(-1)?.content === "hold") {
          started.resolve();
          await gate.promise;
        }
        return { text: "finished" };
      }),
    ],
    sessions: { retentionMs: 60_000 },
    usage: { hostId: "host", accounts: { mock: "shared" } },
    scheduling: {
      total: 1,
      perSubject: 1,
      perAccount: 1,
      queue: { total: 2, perSubject: 1 },
    },
  });
  const server = await serve(driver, {
    port: 0,
    tokens: [
      {
        token,
        subject: "alice",
        providers: ["mock"],
        sessions: ["create", "read", "delete"],
      },
      { token: token + "bob", subject: "bob", providers: ["mock"] },
    ],
  });
  const alice = new AgenticClient({ url: server.url, token });
  const bob = new AgenticClient({ url: server.url, token: token + "bob" });
  const active = alice.stream({ ...base, input: "hold" });
  const queued = bob.stream(base);
  try {
    await active.next();
    await started.promise;
    assert.equal((await queued.next()).value?.type, "run.started");
    assert.deepEqual(driver.scheduler!.stats, { active: 1, queued: 1 });
    await assert.rejects(bob.run(base), {
      code: "QUEUE_FULL",
      retryable: true,
    });
    const created = await alice.createSession({
      provider: "mock",
      model: "demo",
      mode: "history",
    });
    assert.equal(
      (await alice.readSession({ id: created.session.id })).session.state,
      "ready",
    );
    assert.equal(
      (await alice.deleteSession({ id: created.session.id })).deleted,
      true,
    );
    gate.resolve();
    assert.equal((await finish(active)).type, "run.completed");
    assert.equal((await finish(queued)).type, "run.completed");
  } finally {
    gate.resolve();
    await active.return(undefined);
    await queued.return(undefined);
    await server.close();
  }
  assert.deepEqual(driver.scheduler!.stats, { active: 0, queued: 0 });
});

test("shutdown cancels active and queued work, and replay leaves no ticket behind", async () => {
  const driver = new AgenticDriver({
    providers: [
      mockProvider((request) =>
        request.messages.at(-1)?.content === "hold"
          ? new Promise(() => {})
          : { text: "done" },
      ),
    ],
    operations: new MemoryOperationStore(),
    scheduling: { total: 1, queue: { total: 3, perSubject: 2 } },
  });
  const server = await serve(driver, {
    port: 0,
    tokens: [{ token, subject: "alice", providers: ["mock"] }],
  });
  const client = new AgenticClient({ url: server.url, token });
  const first = await client.run({ ...base, idempotencyKey: "once" });
  const held = client.stream({ ...base, input: "hold" });
  const queued = client.stream(base);
  try {
    await held.next();
    assert.equal(
      (await client.run({ ...base, idempotencyKey: "once" })).runId,
      first.runId,
    );
    assert.equal(driver.scheduler!.stats.queued, 0);
    await queued.next();
    assert.equal(driver.scheduler!.stats.queued, 1);
    await server.close();
    assert.deepEqual(driver.scheduler!.stats, { active: 0, queued: 0 });
  } finally {
    await held.return(undefined);
    await queued.return(undefined);
    await server.close();
  }
});

test("disabled queues retain BUSY and ambiguous scheduler configuration is rejected", async () => {
  const scheduler = new FairScheduler({ total: 1 });
  const held = scheduler.submit({ subject: "alice" }, signal());
  assert.throws(() => scheduler.submit({ subject: "bob" }, signal()), {
    code: "BUSY",
    retryable: true,
  });
  held.release();
  assert.throws(() => new FairScheduler({ total: 0 }), {
    code: "INVALID_SCHEDULING",
  });
  const driver = new AgenticDriver({
    providers: [mockProvider()],
    scheduling: { total: 1 },
  });
  await assert.rejects(
    serve(driver, {
      tokens: [{ token, subject: "alice", providers: ["mock"] }],
      maxConcurrentRuns: 2,
    }),
    { code: "INVALID_SCHEDULING" },
  );
});

test("embedded admission rejection records a complete idempotent outcome", async () => {
  let calls = 0;
  const driver = new AgenticDriver({
    providers: [mockProvider(() => ({ text: String(++calls) }))],
    scheduling: { total: 1 },
    operations: new MemoryOperationStore(),
  });
  const held = driver.scheduler!.submit({ subject: "occupier" }, signal());
  const request = { ...base, idempotencyKey: "rejected-admission" };
  await assert.rejects(driver.run(request), { code: "BUSY" });
  held.release();
  const replay = [];
  for await (const event of driver.stream(request)) replay.push(event);
  assert.deepEqual(
    replay.map((event) => event.type),
    ["run.started", "run.failed"],
  );
  assert.equal(
    replay[1]?.type === "run.failed" && replay[1].error.code,
    "BUSY",
  );
  assert.equal(calls, 0);
  assert.deepEqual(driver.scheduler!.stats, { active: 0, queued: 0 });
});
