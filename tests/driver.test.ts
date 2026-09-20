import assert from "node:assert/strict";
import test from "node:test";
import {
  setTimeout as delay,
  setImmediate as immediate,
} from "node:timers/promises";
import { AgenticDriver } from "../src/driver.js";
import { mockProvider } from "../src/providers/mock.js";
import type { RunEvent, Tool, UsageRecord } from "../src/types.js";

const request = { provider: "mock", model: "demo", input: "Find evidence" };
const search: Tool = {
  name: "search",
  description: "Find passages",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  },
  execute: (input) => [
    { paperId: "paper-1", passageId: "p1", text: input.query! },
  ],
};

test("executes a validated tool loop and records scoped usage without prompt data", async () => {
  const records: UsageRecord[] = [];
  const driver = new AgenticDriver({
    tools: [search],
    onUsage: (r) => {
      records.push(r);
    },
    providers: [
      mockProvider((r) =>
        r.messages.some((m) => m.role === "tool")
          ? {
              text: "Evidence [paper-1:p1]",
              usage: { inputTokens: 20, outputTokens: 5 },
            }
          : {
              text: "Searching",
              toolCalls: [
                {
                  id: "call-1",
                  name: "search",
                  arguments: { query: "evidence" },
                },
              ],
              usage: { inputTokens: 10, outputTokens: 2 },
            },
      ),
    ],
  });
  const events: RunEvent[] = [];
  for await (const event of driver.stream(
    { ...request, tools: ["search"], metadata: { app: "literature-review" } },
    { subject: "user-1" },
  ))
    events.push(event);
  assert.deepEqual(
    events.map((e) => e.sequence),
    events.map((_, i) => i + 1),
  );
  assert.equal(new Set(events.map((e) => e.runId)).size, 1);
  const result = events.at(-1)!;
  assert.equal(result.type, "run.completed");
  if (result.type !== "run.completed") throw new Error("Expected result");
  assert.equal(result.result.text, "Evidence [paper-1:p1]");
  assert.deepEqual(result.result.usage, { inputTokens: 30, outputTokens: 7 });
  assert.equal(result.result.steps, 2);
  assert.equal(records[0]?.subject, "user-1");
  assert.equal(records[0]?.status, "completed");
  assert.equal(JSON.stringify(records).includes("Find evidence"), false);
});

test("validates an entire tool batch before invoking any tool", async () => {
  let calls = 0;
  const driver = new AgenticDriver({
    tools: [
      {
        ...search,
        execute: () => {
          calls++;
          return {};
        },
      },
    ],
    providers: [
      mockProvider(() => ({
        text: "",
        toolCalls: [
          { id: "1", name: "search", arguments: { query: "ok" } },
          { id: "2", name: "search", arguments: { query: 17 } },
        ],
      })),
    ],
  });
  await assert.rejects(driver.run({ ...request, tools: ["search"] }), {
    code: "INVALID_TOOL_ARGUMENTS",
  });
  assert.equal(calls, 0);
});

test("tools require a per-run allowlist and host approval for writes", async () => {
  let calls = 0;
  const provider = mockProvider(() => ({
    text: "",
    toolCalls: [{ id: "1", name: "search", arguments: { query: "ok" } }],
  }));
  const driver = new AgenticDriver({
    tools: [
      {
        ...search,
        requiresApproval: true,
        execute: () => {
          calls++;
          return {};
        },
      },
    ],
    providers: [provider],
  });
  await assert.rejects(driver.run(request), { code: "TOOL_NOT_ALLOWED" });
  await assert.rejects(driver.run({ ...request, tools: ["search"] }), {
    code: "APPROVAL_REQUIRED",
  });
  assert.equal(calls, 0);
});

test("stops before executing tools on the final step", async () => {
  let called = false;
  const driver = new AgenticDriver({
    limits: { maxSteps: 1 },
    tools: [
      {
        ...search,
        execute: () => {
          called = true;
          return null;
        },
      },
    ],
    providers: [
      mockProvider(() => ({
        text: "",
        toolCalls: [{ id: "1", name: "search", arguments: { query: "ok" } }],
      })),
    ],
  });
  await assert.rejects(
    driver.run({ ...request, tools: ["search"], maxSteps: 10 }),
    { code: "STEP_LIMIT" },
  );
  assert.equal(called, false);
});

test("aborts uncooperative providers only when an inactivity timeout is configured", async () => {
  const records: UsageRecord[] = [];
  const driver = new AgenticDriver({
    limits: { idleTimeoutMs: 20 },
    onUsage: (r) => {
      records.push(r);
    },
    providers: [mockProvider(() => new Promise(() => {}))],
  });
  await assert.rejects(driver.run({ ...request, idleTimeoutMs: 0 }), {
    code: "IDLE_TIMEOUT",
  });
  assert.equal(records[0]?.status, "cancelled");
});

test("omitting or disabling the idle timeout allows a silent run to outlive a week", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const idleTimeoutMs of [undefined, 0]) {
    let finish!: () => void;
    let signal!: AbortSignal;
    const driver = new AgenticDriver({
      providers: [
        mockProvider(async (_request, context) => {
          signal = context.signal;
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          return { text: "finished" };
        }),
      ],
    });
    const pending = driver.run({ ...request, idleTimeoutMs });
    await immediate();
    t.mock.timers.tick(7 * 24 * 60 * 60 * 1000);
    assert.equal(signal.aborted, false);
    finish();
    assert.equal((await pending).text, "finished");
  }
});

test("reasoning, text, and real tool progress keep a run alive beyond its idle interval", async () => {
  const driver = new AgenticDriver({
    providers: [
      mockProvider(async (r, context) => {
        if (r.messages.some((m) => m.role === "tool")) return { text: "done" };
        for (let i = 0; i < 5; i++) {
          await delay(20);
          context.reportProgress();
        }
        for (const text of ["Look", "ing"]) {
          await delay(20);
          context.emitText(text);
        }
        return {
          text: "Looking",
          toolCalls: [
            { id: "1", name: "search", arguments: { query: "evidence" } },
          ],
        };
      }),
    ],
    tools: [
      {
        ...search,
        async execute(_input, context) {
          for (let i = 0; i < 5; i++) {
            await delay(20);
            context.reportProgress();
          }
          return { found: true };
        },
      },
    ],
  });
  const events: RunEvent[] = [];
  for await (const event of driver.stream({
    ...request,
    tools: ["search"],
    idleTimeoutMs: 80,
  }))
    events.push(event);
  assert.equal(events.at(-1)?.type, "run.completed");
  assert.deepEqual(
    events.filter((e) => e.type === "text.delta").map((e) => e.text),
    ["Look", "ing", "done"],
  );
  assert.ok(
    events.some((e) => e.type === "run.progress" && e.phase === "model"),
  );
  assert.ok(
    events.some((e) => e.type === "run.progress" && e.phase === "tool"),
  );
});

test("the idle timer restarts after progress and cancels a subsequently stalled tool", async () => {
  let toolSignal!: AbortSignal;
  const driver = new AgenticDriver({
    providers: [
      mockProvider(() => ({
        text: "",
        toolCalls: [{ id: "1", name: "search", arguments: { query: "q" } }],
      })),
    ],
    tools: [
      {
        ...search,
        async execute(_input, context) {
          toolSignal = context.signal;
          for (let i = 0; i < 3; i++) {
            await delay(15);
            context.reportProgress();
          }
          return new Promise(() => {});
        },
      },
    ],
  });
  await assert.rejects(
    driver.run({ ...request, tools: ["search"], idleTimeoutMs: 50 }),
    { code: "IDLE_TIMEOUT", outcome: "uncertain", retryable: false },
  );
  assert.equal(toolSignal.aborted, true);
});

test("closing during a text delta cancels the active provider without waiting for completion", async () => {
  let signal!: AbortSignal;
  const driver = new AgenticDriver({
    providers: [
      mockProvider(async (_request, context) => {
        signal = context.signal;
        context.emitText("first");
        return new Promise(() => {});
      }),
    ],
  });
  for await (const event of driver.stream(request))
    if (event.type === "text.delta") break;
  assert.equal(signal.aborted, true);
});

test("honors pre-cancellation without contacting a provider", async () => {
  let calls = 0;
  const driver = new AgenticDriver({
    providers: [
      mockProvider(() => {
        calls++;
        return { text: "no" };
      }),
    ],
  });
  await assert.rejects(driver.run(request, { signal: AbortSignal.abort() }), {
    code: "CANCELLED",
  });
  assert.equal(calls, 0);
});

test("breaking a local event stream stops the next provider step", async () => {
  let calls = 0;
  const driver = new AgenticDriver({
    providers: [
      mockProvider(() => {
        calls++;
        return { text: "no" };
      }),
    ],
  });
  for await (const _event of driver.stream(request)) break;
  assert.equal(calls, 0);
});

test("validates structured output and rejects unknown request fields", async () => {
  const driver = new AgenticDriver({
    providers: [mockProvider(() => ({ text: '{"names":["Lumen"]}' }))],
  });
  const outputSchema = {
    type: "object",
    properties: { names: { type: "array", items: { type: "string" } } },
    required: ["names"],
    additionalProperties: false,
  };
  assert.deepEqual((await driver.run({ ...request, outputSchema })).output, {
    names: ["Lumen"],
  });
  await assert.rejects(
    driver.run({ ...request, outputSchema: { type: "integer" } }),
    { code: "INVALID_OUTPUT" },
  );
  await assert.rejects(
    driver.run({ ...request, ...{ executable: "/bin/sh" } }),
    { code: "INVALID_REQUEST" },
  );
});

test("unknown usage stays unknown and telemetry failure cannot invalidate a successful run", async () => {
  const driver = new AgenticDriver({
    providers: [mockProvider(() => ({ text: "done" }))],
    onUsage: () => {
      throw new Error("sink failed");
    },
  });
  assert.deepEqual((await driver.run(request)).usage, {});
});

test("does not leak private provider or tool exceptions", async () => {
  const driver = new AgenticDriver({
    providers: [
      mockProvider(() => {
        throw new Error("secret-credential");
      }),
    ],
  });
  await assert.rejects(
    driver.run(request),
    (e) =>
      e instanceof Error &&
      !e.message.includes("secret-credential") &&
      "code" in e &&
      e.code === "INTERNAL_ERROR",
  );
});
