import assert from "node:assert/strict";
import test from "node:test";
import { AgenticDriver, type DriverOptions } from "../src/driver.js";
import { AgenticClient } from "../src/client.js";
import { mockProvider } from "../src/providers/mock.js";
import { serve } from "../src/server.js";
import { SessionManager } from "../src/sessions.js";
import { MemoryOperationStore } from "../src/operations.js";
import type { ProviderMessage, RunRequest } from "../src/types.js";
import type { SessionCreate, SessionSnapshot } from "../src/session-types.js";

const create: SessionCreate = {
  provider: "mock",
  model: "demo",
  mode: "history",
};
const base: RunRequest = { provider: "mock", model: "demo", input: "hello" };
const handle = (snapshot: SessionSnapshot) => ({
  id: snapshot.session.id,
  revision: snapshot.session.revision,
});
const lookup = (snapshot: SessionSnapshot) => ({ id: snapshot.session.id });
function setup(options: Partial<DriverOptions> = {}) {
  return new AgenticDriver({
    providers: [
      mockProvider(() => ({
        text: "reply",
        native: { private: "private-reasoning-marker" },
      })),
    ],
    usage: { hostId: "test-host", accounts: { mock: "account-one" } },
    sessions: { retentionMs: 60_000 },
    ...options,
  });
}

test("sessions are opt-in, account-bound and select supported continuation explicitly", async () => {
  const disabled = setup({ sessions: undefined });
  assert.throws(() => disabled.createSession(create), {
    code: "SESSIONS_UNAVAILABLE",
  });
  assert.equal((await disabled.run(base)).session, undefined);
  assert.throws(() => setup({ usage: undefined }).createSession(create), {
    code: "SESSION_ACCOUNT_REQUIRED",
  });
  assert.throws(() => setup({ sessions: { retentionMs: 0 } }), {
    code: "INVALID_SESSION_CONFIG",
  });
  const provider = mockProvider();
  provider.info.capabilities.nativeContinuation = false;
  const driver = setup({ providers: [provider] });
  assert.throws(() => driver.createSession({ ...create, mode: "native" }), {
    code: "UNSUPPORTED_CONTINUATION",
  });
  const conversation = driver.createSession(create);
  for (const extra of [
    { history: [] },
    { instructions: "replace" },
    { retrieval: { corpus: "library", query: "query" } },
  ])
    await assert.rejects(
      driver.run({ ...base, ...extra, session: handle(conversation) }),
      {
        code:
          "retrieval" in extra
            ? "SESSION_CONTEXT_UNSUPPORTED"
            : "SESSION_HISTORY_CONFLICT",
      },
    );
  driver.deleteSession(lookup(conversation));
});

test("portable history and opaque native continuation remain separate across turns", async () => {
  for (const mode of ["history", "native"] as const) {
    const received: ProviderMessage[][] = [];
    const driver = setup({
      providers: [
        mockProvider((request) => {
          received.push(structuredClone(request.messages));
          assert.equal(request.instructions, "session instructions");
          return {
            text: "visible reply",
            native: { private: "private-reasoning-marker" },
          };
        }),
      ],
    });
    const created = driver.createSession({
      ...create,
      mode,
      instructions: "session instructions",
      history: [{ role: "user", content: "initial" }],
    });
    const first = await driver.run({ ...base, session: handle(created) });
    assert.equal(first.session?.revision, 1);
    const saved = driver.readSession(lookup(created));
    assert.equal(saved.history.length, 3);
    assert.equal(
      JSON.stringify({ first, saved }).includes("private-reasoning-marker"),
      false,
    );
    saved.history[0]!.content = "external mutation";
    const second = await driver.run({
      ...base,
      input: "follow up",
      session: { id: created.session.id, revision: 1 },
    });
    assert.equal(second.session?.revision, 2);
    assert.equal(received[1]?.[0]?.content, "initial");
    assert.equal(
      JSON.stringify(received[1]).includes("private-reasoning-marker"),
      mode === "native",
    );
    assert.deepEqual(
      driver
        .readSession(lookup(created))
        .history.map((message) => message.content),
      ["initial", "hello", "visible reply", "follow up", "visible reply"],
    );
    driver.deleteSession(lookup(created));
  }
});

test("a session permits one writer and rejects stale revisions and provider/model switching", async () => {
  let entered!: () => void, finish!: () => void;
  const running = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const provider = mockProvider(async () => {
    entered();
    await waiting;
    return { text: "done" };
  });
  provider.info.models = ["demo", "alternate"];
  const driver = setup({ providers: [provider] });
  const created = driver.createSession(create);
  const request = { ...base, session: handle(created) };
  const result = driver.run(request);
  await running;
  assert.equal(driver.readSession(lookup(created)).session.state, "running");
  assert.equal(
    driver.readSession(lookup(created)).session.expiresAt,
    undefined,
  );
  await assert.rejects(driver.run(request), { code: "SESSION_BUSY" });
  await assert.rejects(driver.run({ ...request, model: "alternate" }), {
    code: "SESSION_PROVIDER_MISMATCH",
  });
  finish();
  await result;
  await assert.rejects(driver.run(request), {
    code: "SESSION_REVISION_CONFLICT",
  });
  driver.deleteSession(lookup(created));
});

test("subject, provider grants and each session permission are enforced", async () => {
  const driver = setup();
  assert.throws(() => driver.createSession(create, { sessions: [] }), {
    code: "FORBIDDEN",
  });
  const created = driver.createSession(create, { subject: "alice" });
  for (const method of ["readSession", "deleteSession"] as const) {
    assert.throws(() => driver[method](lookup(created), { subject: "bob" }), {
      code: "SESSION_NOT_FOUND",
    });
    assert.throws(
      () =>
        driver[method](lookup(created), { subject: "alice", providers: [] }),
      { code: "FORBIDDEN" },
    );
    assert.throws(
      () => driver[method](lookup(created), { subject: "alice", sessions: [] }),
      { code: "FORBIDDEN" },
    );
  }
  await assert.rejects(
    driver.run(
      { ...base, session: handle(created) },
      { subject: "alice", sessionOperations: ["read"] },
    ),
    { code: "FORBIDDEN" },
  );
  driver.deleteSession(lookup(created), { subject: "alice" });
  assert.throws(
    () => driver.readSession(lookup(created), { subject: "alice" }),
    { code: "SESSION_NOT_FOUND" },
  );
});

test("changed account bindings cannot read or continue opaque state, but can delete it", () => {
  let accountId = "one";
  const manager = new SessionManager(
    { retentionMs: 60_000 },
    () => ({ hostId: "host", accountId }),
    () => mockProvider().info,
  );
  const created = manager.create({ ...create, mode: "native" });
  accountId = "two";
  assert.throws(() => manager.read(lookup(created)), {
    code: "SESSION_ACCOUNT_CHANGED",
  });
  assert.throws(
    () => manager.begin({ ...base, session: handle(created) }, {}),
    { code: "SESSION_ACCOUNT_CHANGED" },
  );
  manager.delete(lookup(created));
});

test(
  "deleting an active session cancels work and cannot resurrect the deleted state",
  { timeout: 2000 },
  async () => {
    let entered!: () => void;
    const running = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const driver = setup({
      providers: [
        mockProvider(async () => {
          entered();
          return new Promise(() => {});
        }),
      ],
    });
    const created = driver.createSession(create),
      pending = driver.run({ ...base, session: handle(created) });
    await running;
    driver.deleteSession(lookup(created));
    await assert.rejects(pending, { code: "SESSION_DELETED" });
    assert.throws(() => driver.readSession(lookup(created)), {
      code: "SESSION_NOT_FOUND",
    });
  },
);

test("idle retention never becomes an active run deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let entered!: () => void, finish!: () => void;
  const running = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const driver = setup({
    sessions: { retentionMs: 10 },
    providers: [
      mockProvider(async () => {
        entered();
        await waiting;
        return { text: "done" };
      }),
    ],
  });
  const created = driver.createSession(create),
    pending = driver.run({ ...base, session: handle(created) });
  await running;
  t.mock.timers.tick(7 * 86_400_000);
  assert.equal(driver.readSession(lookup(created)).session.state, "running");
  finish();
  assert.equal((await pending).session?.revision, 1);
  t.mock.timers.tick(11);
  assert.throws(() => driver.readSession(lookup(created)), {
    code: "SESSION_NOT_FOUND",
  });
});

test("interrupted turns require explicit reconciliation and no automatic continuation", async () => {
  const driver = setup({
    providers: [
      mockProvider(() => {
        throw new Error("private failure");
      }),
    ],
  });
  const created = driver.createSession(create),
    request = { ...base, session: handle(created) };
  await assert.rejects(driver.run(request), { code: "INTERNAL_ERROR" });
  assert.equal(
    driver.readSession(lookup(created)).session.state,
    "interrupted",
  );
  assert.deepEqual(driver.readSession(lookup(created)).history, []);
  await assert.rejects(driver.run(request), { code: "SESSION_INTERRUPTED" });
  driver.deleteSession(lookup(created));
});

test("bounded conversation storage rejects capacity and context growth without silent eviction", async () => {
  const driver = setup({
    sessions: { retentionMs: 60_000, maxEntries: 1, maxMessages: 2 },
  });
  const created = driver.createSession(create);
  assert.throws(() => driver.createSession(create), {
    code: "SESSION_CAPACITY",
  });
  await driver.run({ ...base, session: handle(created) });
  await assert.rejects(
    driver.run({ ...base, session: { id: created.session.id, revision: 1 } }),
    { code: "SESSION_CONTEXT_LIMIT" },
  );
  assert.equal(driver.readSession(lookup(created)).history.length, 2);
  driver.deleteSession(lookup(created));
  const bounded = setup({
    sessions: { retentionMs: 60_000, maxRecordBytes: 256 },
    providers: [
      mockProvider(() => ({
        text: "visible",
        native: { private: "x".repeat(1000) },
      })),
    ],
  });
  const native = bounded.createSession({ ...create, mode: "native" });
  await assert.rejects(bounded.run({ ...base, session: handle(native) }), {
    code: "SESSION_CONTEXT_LIMIT",
  });
  assert.equal(
    bounded.readSession(lookup(native)).session.state,
    "interrupted",
  );
  bounded.deleteSession(lookup(native));
});

test("idempotent replay cannot advance or recreate a deleted conversation", async () => {
  let calls = 0;
  const driver = setup({
    operations: new MemoryOperationStore(),
    providers: [mockProvider(() => ({ text: String(++calls) }))],
  });
  const created = driver.createSession(create),
    request = { ...base, session: handle(created), idempotencyKey: "turn-one" };
  const first = await driver.run(request),
    replay = await driver.run(request);
  assert.deepEqual(replay, first);
  assert.equal(calls, 1);
  assert.equal(driver.readSession(lookup(created)).session.revision, 1);
  driver.deleteSession(lookup(created));
  await assert.rejects(driver.run(request), { code: "SESSION_NOT_FOUND" });
  assert.equal(calls, 1);
});

test("invalid native state cannot partially commit visible history or bypass its byte bound", async () => {
  for (const native of [
    new Map([["private", "x".repeat(1000)]]),
    { callback() {} },
    { invalid: Number.NaN },
  ]) {
    const driver = setup({
      providers: [mockProvider(() => ({ text: "new reply", native }))],
    });
    const created = driver.createSession({
      ...create,
      mode: "native",
      history: [{ role: "user", content: "original" }],
    });
    await assert.rejects(driver.run({ ...base, session: handle(created) }), {
      code: "INVALID_SESSION_STATE",
    });
    const saved = driver.readSession(lookup(created));
    assert.equal(saved.session.revision, 0);
    assert.deepEqual(saved.history, [{ role: "user", content: "original" }]);
    driver.deleteSession(lookup(created));
  }
});

test("closing before generation releases a session for another turn", async () => {
  const driver = setup();
  const created = driver.createSession(create);
  const stream = driver.stream({ ...base, session: handle(created) });
  assert.equal((await stream.next()).value?.type, "run.started");
  await stream.return(undefined);
  assert.equal(driver.readSession(lookup(created)).session.state, "ready");
  const result = await driver.run({ ...base, session: handle(created) });
  assert.equal(result.session?.revision, 1);
  driver.deleteSession(lookup(created));
});

test("cancellation releases a session while its consumer is paused at an event", async () => {
  const driver = setup(),
    controller = new AbortController();
  const created = driver.createSession(create);
  const first = driver.stream(
    { ...base, session: handle(created) },
    { signal: controller.signal },
  );
  assert.equal((await first.next()).value?.type, "run.started");
  controller.abort();
  assert.equal(driver.readSession(lookup(created)).session.state, "ready");
  const replacement = driver.stream({ ...base, session: handle(created) });
  assert.equal((await replacement.next()).value?.type, "run.started");
  await first.return(undefined);
  assert.equal(driver.readSession(lookup(created)).session.state, "running");
  await replacement.return(undefined);
  driver.deleteSession(lookup(created));
});

test(
  "cancelling active model work preserves an interrupted revision",
  { timeout: 2000 },
  async () => {
    let entered!: () => void;
    const running = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const driver = setup({
      providers: [
        mockProvider(async () => {
          entered();
          return new Promise(() => {});
        }),
      ],
    });
    const created = driver.createSession(create),
      controller = new AbortController();
    const pending = driver.run(
      { ...base, session: handle(created) },
      { signal: controller.signal },
    );
    await running;
    controller.abort();
    assert.equal(
      driver.readSession(lookup(created)).session.state,
      "interrupted",
    );
    await assert.rejects(pending, { code: "CANCELLED" });
    assert.equal(driver.readSession(lookup(created)).session.revision, 0);
    driver.deleteSession(lookup(created));
  },
);

test("native tool history rejects reused call IDs before repeating an application action", async () => {
  let effects = 0;
  const driver = setup({
    providers: [
      mockProvider((input) =>
        input.messages.at(-1)?.role === "tool"
          ? { text: "done" }
          : {
              text: "",
              toolCalls: [{ id: "one", name: "action", arguments: {} }],
            },
      ),
    ],
    tools: [
      {
        name: "action",
        description: "test action",
        inputSchema: { type: "object" },
        execute: () => ++effects,
      },
    ],
  });
  const created = driver.createSession({ ...create, mode: "native" });
  await driver.run({ ...base, tools: ["action"], session: handle(created) });
  await assert.rejects(
    driver.run({
      ...base,
      tools: ["action"],
      session: { id: created.session.id, revision: 1 },
    }),
    { code: "INVALID_TOOL_CALL" },
  );
  assert.equal(effects, 1);
  driver.deleteSession(lookup(created));
});

test("HTTP sessions round-trip without exposing account state and reject identity forgery", async () => {
  const token = "x".repeat(32),
    restricted = "y".repeat(32);
  const host = await serve(setup(), {
    port: 0,
    tokens: [
      {
        token,
        subject: "alice",
        providers: ["mock"],
        sessions: ["create", "read", "continue", "delete"],
      },
      { token: restricted, subject: "alice", providers: ["mock"] },
    ],
  });
  try {
    const client = new AgenticClient({ url: host.url, token });
    const denied = new AgenticClient({ url: host.url, token: restricted });
    assert.ok(
      (await client.protocol()).features.includes("conversation-sessions"),
    );
    await assert.rejects(denied.createSession(create), { code: "FORBIDDEN" });
    await assert.rejects(
      client.createSession({ ...create, subject: "forged" } as SessionCreate),
      { code: "INVALID_SESSION" },
    );
    const created = await client.createSession({ ...create, mode: "native" });
    await assert.rejects(denied.run({ ...base, session: handle(created) }), {
      code: "FORBIDDEN",
    });
    const result = await client.run({ ...base, session: handle(created) });
    assert.equal(result.session?.revision, 1);
    const saved = await client.readSession(lookup(created));
    assert.equal(saved.history.length, 2);
    assert.equal(
      JSON.stringify(saved).includes("private-reasoning-marker"),
      false,
    );
    assert.deepEqual(await client.deleteSession(lookup(created)), {
      id: created.session.id,
      deleted: true,
    });
    await assert.rejects(client.readSession(lookup(created)), {
      code: "SESSION_NOT_FOUND",
    });
  } finally {
    await host.close();
  }
});
