import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as immediate } from "node:timers/promises";
import { AgenticDriver, type DriverOptions } from "../src/driver.js";
import { AgenticClient } from "../src/client.js";
import { mockProvider } from "../src/providers/mock.js";
import { serve } from "../src/server.js";
import { MemoryOperationStore } from "../src/operations.js";
import type {
  ApplicationToolDefinition,
  ToolExecutionIdentity,
  ToolExecutionRequest,
} from "../src/tool-types.js";
import type { JsonObject, RunRequest, RunEvent } from "../src/types.js";

const definition: ApplicationToolDefinition = {
  name: "lookup",
  description: "Find app-owned passages",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { passages: { type: "array", items: { type: "string" } } },
    required: ["passages"],
    additionalProperties: false,
  },
};
const request: RunRequest = {
  provider: "mock",
  model: "demo",
  input: "Find evidence",
  tools: ["lookup"],
  applicationTools: [definition],
};
const call = {
  id: "lookup-one",
  name: "lookup",
  arguments: { query: "solar" },
};
function setup(options: Partial<DriverOptions> = {}) {
  return new AgenticDriver({
    providers: [
      mockProvider((input) =>
        input.messages.some((message) => message.role === "tool")
          ? { text: "finished", usage: { inputTokens: 1, outputTokens: 1 } }
          : {
              text: "",
              toolCalls: [call],
              usage: { inputTokens: 1, outputTokens: 1 },
            },
      ),
    ],
    applicationTools: { enabled: true, requireApproval: false },
    approvals: { interactive: true },
    ...options,
  });
}
function identity(execution: ToolExecutionRequest): ToolExecutionIdentity {
  return {
    executionId: execution.executionId,
    runId: execution.runId,
    callId: execution.call.id,
  };
}
async function invoked(stream: AsyncGenerator<RunEvent>) {
  for (;;) {
    const event = await stream.next();
    assert.equal(event.done, false);
    if (event.value?.type === "tool.execution.requested")
      return event.value.execution;
    assert.notEqual(
      event.value?.type,
      "run.failed",
      JSON.stringify(event.value),
    );
  }
}
async function collect(stream: AsyncGenerator<RunEvent>) {
  const events: RunEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
const lookup = (input: JsonObject) => ({
  passages: [`Evidence for ${input.query}`],
});

test("an embedded application's own function supplies a schema-checked tool result once", async () => {
  const driver = setup();
  const stream = driver.stream(request),
    execution = await invoked(stream);
  const message = identity(execution),
    output = lookup(execution.call.arguments);
  assert.equal(driver.reportToolProgress(message).status, "progress");
  assert.equal(driver.completeTool({ ...message, output }).status, "accepted");
  assert.throws(() => driver.completeTool({ ...message, output }), {
    code: "TOOL_EXECUTION_NOT_FOUND",
  });
  assert.throws(() => driver.reportToolProgress(message), {
    code: "TOOL_EXECUTION_NOT_FOUND",
  });
  const events = await collect(stream);
  assert.deepEqual(
    events.find((e) => e.type === "tool.completed")?.output,
    output,
  );
  assert.equal(events.at(-1)?.type, "run.completed");
});

test("application execution requires host opt-in, selection, unique names and self-contained schemas", async () => {
  const driver = setup();
  const failures: [RunRequest, string][] = [
    [{ ...request, tools: [] }, "INVALID_REQUEST"],
    [
      { ...request, applicationTools: [definition, definition] },
      "TOOL_DEFINITION_CONFLICT",
    ],
    [
      {
        ...request,
        applicationTools: [
          { ...definition, inputSchema: { $async: true, type: "object" } },
        ],
      },
      "INVALID_SCHEMA",
    ],
    [
      {
        ...request,
        applicationTools: [
          {
            ...definition,
            outputSchema: { $ref: "https://private.example/schema" },
          },
        ],
      },
      "INVALID_SCHEMA",
    ],
    [
      {
        ...request,
        applicationTools: [
          {
            ...definition,
            command: "never executed",
          } as ApplicationToolDefinition,
        ],
      },
      "INVALID_REQUEST",
    ],
  ];
  for (const [input, code] of failures)
    await assert.rejects(collect(driver.stream(input)), { code });
  await assert.rejects(
    collect(setup({ applicationTools: undefined }).stream(request)),
    { code: "APPLICATION_TOOLS_UNAVAILABLE" },
  );
  await assert.rejects(driver.run(request), { code: "TOOL_STREAM_REQUIRED" });
  const registered = setup({ tools: [{ ...definition, execute: () => null }] });
  await assert.rejects(collect(registered.stream(request)), {
    code: "TOOL_DEFINITION_CONFLICT",
  });
});

test("input validation rejects the whole batch before dispatching any application function", async () => {
  const driver = setup({
    providers: [
      mockProvider(() => ({
        text: "",
        toolCalls: [
          call,
          { ...call, id: "invalid", arguments: { unexpected: true } },
        ],
      })),
    ],
  });
  const events = await collect(driver.stream(request)),
    last = events.at(-1);
  assert.equal(
    events.some((e) => e.type === "tool.execution.requested"),
    false,
  );
  assert.equal(last?.type, "run.failed");
  if (last?.type === "run.failed")
    assert.equal(last.error.code, "INVALID_TOOL_ARGUMENTS");
});

test("subject, provider, executor grant and invocation identity are all required", async () => {
  const driver = setup(),
    stream = driver.stream(request, { subject: "alice" });
  const execution = await invoked(stream),
    value = {
      ...identity(execution),
      output: lookup(execution.call.arguments),
    };
  for (const [principal, code] of [
    [{ subject: "bob" }, "TOOL_EXECUTION_NOT_FOUND"],
    [{ subject: "alice", providers: [] }, "FORBIDDEN"],
    [{ subject: "alice", applicationTools: [] }, "FORBIDDEN"],
  ] as const)
    assert.throws(() => driver.completeTool(value, principal), { code });
  for (const field of ["runId", "callId"] as const) {
    assert.throws(
      () =>
        driver.completeTool(
          { ...value, [field]: "altered" },
          { subject: "alice" },
        ),
      { code: "TOOL_EXECUTION_MISMATCH" },
    );
    assert.throws(
      () =>
        driver.reportToolProgress(
          { ...identity(execution), [field]: "altered" },
          { subject: "alice" },
        ),
      { code: "TOOL_EXECUTION_MISMATCH" },
    );
  }
  driver.completeTool(value, {
    subject: "alice",
    providers: ["mock"],
    applicationTools: ["lookup"],
  });
  assert.equal((await collect(stream)).at(-1)?.type, "run.completed");
});

test("host, token and application review requirements cannot be lowered by a definition", async () => {
  for (const scope of ["host", "token", "application"] as const) {
    const driver = setup({
      applicationTools: { enabled: true, requireApproval: scope === "host" },
    });
    const input = {
      ...request,
      applicationTools: [
        { ...definition, requiresApproval: scope === "application" },
      ],
    };
    const options =
      scope === "token" ? { applicationToolApprovals: ["lookup"] } : {};
    const denied = await collect(driver.stream(input, options)),
      last = denied.at(-1);
    assert.equal(
      denied.some((e) => e.type === "tool.execution.requested"),
      false,
    );
    assert.equal(last?.type, "run.failed");
    if (last?.type === "run.failed")
      assert.equal(last.error.code, "APPROVAL_REQUIRED");
    let approved = false,
      executions = 0;
    for await (const event of driver.stream(
      { ...input, approvals: { mode: "interactive", idlePolicy: "pause" } },
      options,
    )) {
      if (event.type === "approval.requested") {
        const { approvalId, runId, call } = event.approval;
        driver.decideApproval({ approvalId, runId, call, decision: "approve" });
        approved = true;
      }
      if (event.type === "tool.execution.requested") {
        assert.equal(approved, true);
        executions++;
        driver.completeTool({
          ...identity(event.execution),
          output: lookup(event.execution.call.arguments),
        });
      }
      if (event.type === "run.failed") assert.fail(event.error.code);
    }
    assert.equal(executions, 1);
  }
});

test("invalid output and application exceptions leave an explicit uncertain outcome", async () => {
  for (const failure of ["schema", "limit", "exception"] as const) {
    const driver = setup(),
      stream = driver.stream(request),
      execution = await invoked(stream);
    if (failure === "exception")
      driver.completeTool({
        ...identity(execution),
        error: "APPLICATION_TOOL_FAILED",
      });
    else
      assert.throws(
        () =>
          driver.completeTool({
            ...identity(execution),
            output:
              failure === "schema"
                ? { passages: false }
                : { passages: ["x".repeat(128_001)] },
          }),
        {
          code:
            failure === "schema" ? "INVALID_TOOL_OUTPUT" : "TOOL_OUTPUT_LIMIT",
        },
      );
    const events = await collect(stream),
      last = events.at(-1);
    assert.equal(
      events.some((e) => e.type === "tool.completed"),
      false,
    );
    assert.equal(last?.type, "run.failed");
    if (last?.type === "run.failed")
      assert.equal(last.error.outcome, "uncertain");
    assert.throws(
      () =>
        driver.completeTool({
          ...identity(execution),
          output: lookup(call.arguments),
        }),
      { code: "TOOL_EXECUTION_NOT_FOUND" },
    );
  }
});

test("application progress resets explicit inactivity, with no default deadline or synthetic progress", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  for (const timed of [false, true]) {
    const driver = setup(),
      stream = driver.stream({
        ...request,
        ...(timed ? { idleTimeoutMs: 10 } : {}),
      });
    const execution = await invoked(stream),
      message = identity(execution),
      next = stream.next();
    await immediate();
    if (timed)
      for (let i = 0; i < 20; i++) {
        t.mock.timers.tick(9);
        driver.reportToolProgress(message);
      }
    else t.mock.timers.tick(7 * 86_400_000);
    driver.completeTool({ ...message, output: lookup(call.arguments) });
    const first = await next,
      rest = await collect(stream);
    assert.equal(rest.at(-1)?.type, "run.completed");
    assert.equal(first.value?.type === "run.progress", timed);
  }
});

test("an explicitly configured idle expiry invalidates the execution and preserves uncertainty", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const driver = setup(),
    stream = driver.stream({ ...request, idleTimeoutMs: 10 });
  const execution = await invoked(stream),
    next = stream.next();
  await immediate();
  t.mock.timers.tick(11);
  const events = [
    await next,
    ...(await collect(stream)).map((value) => ({ value })),
  ];
  const last = events.at(-1)?.value;
  assert.equal(last?.type, "run.cancelled");
  if (last?.type === "run.cancelled") {
    assert.equal(last.error.code, "IDLE_TIMEOUT");
    assert.equal(last.error.outcome, "uncertain");
  }
  assert.throws(() => driver.reportToolProgress(identity(execution)), {
    code: "TOOL_EXECUTION_NOT_FOUND",
  });
});

test("malformed, forged and lossy result submissions cannot change a pending execution", async () => {
  const driver = setup(),
    stream = driver.stream(request);
  const execution = await invoked(stream),
    message = identity(execution);
  for (const extra of [
    { output: lookup(call.arguments), subject: "forged" },
    { output: lookup(call.arguments), error: "APPLICATION_TOOL_FAILED" },
    { error: "private exception details" },
    { output: JSON.parse('{"__proto__":{"hidden":true}}') },
  ]) {
    assert.throws(
      () =>
        driver.completeTool({ ...message, ...extra } as Parameters<
          typeof driver.completeTool
        >[0]),
      { code: "INVALID_TOOL_EXECUTION" },
    );
  }
  driver.completeTool({ ...message, output: lookup(call.arguments) });
  assert.equal((await collect(stream)).at(-1)?.type, "run.completed");
});

test("a rejected review never dispatches an application callback", async () => {
  const driver = setup({ applicationTools: { enabled: true } });
  const events: RunEvent[] = [];
  for await (const event of driver.stream({
    ...request,
    approvals: { mode: "interactive", idlePolicy: "pause" },
  })) {
    events.push(event);
    if (event.type === "approval.requested") {
      const { approvalId, runId, call } = event.approval;
      driver.decideApproval({ approvalId, runId, call, decision: "deny" });
    }
  }
  assert.equal(
    events.some((event) => event.type === "tool.execution.requested"),
    false,
  );
  const last = events.at(-1);
  assert.equal(last?.type, "run.failed");
  if (last?.type === "run.failed")
    assert.equal(last.error.code, "APPROVAL_DENIED");
});

test(
  "disconnecting an HTTP executor cancels the host run and rejects late results",
  { timeout: 2000 },
  async () => {
    let observeDisconnect!: () => void;
    const disconnected = new Promise<void>((resolve) => {
      observeDisconnect = resolve;
    });
    const driver = setup({
      providers: [
        mockProvider((_input, context) => {
          context.signal.addEventListener("abort", observeDisconnect, {
            once: true,
          });
          return { text: "", toolCalls: [call] };
        }),
      ],
    });
    const token = "x".repeat(32);
    const host = await serve(driver, {
      port: 0,
      tokens: [
        {
          token,
          subject: "alice",
          providers: ["mock"],
          applicationTools: [{ name: "lookup", requiresApproval: false }],
        },
      ],
    });
    try {
      const client = new AgenticClient({ url: host.url, token });
      const stream = client.stream(request),
        execution = await invoked(stream);
      await stream.return(undefined);
      await disconnected;
      await assert.rejects(
        client.completeTool({
          ...identity(execution),
          output: lookup(call.arguments),
        }),
        { code: "TOOL_EXECUTION_NOT_FOUND" },
      );
    } finally {
      await host.close();
    }
  },
);

test(
  "closing a pending executor cancels promptly and invalidates its ticket",
  { timeout: 2000 },
  async () => {
    const driver = setup({
      applicationTools: {
        enabled: true,
        requireApproval: false,
        maxPending: 1,
      },
    });
    const stream = driver.stream(request),
      execution = await invoked(stream);
    const rejected = (await collect(driver.stream(request))).at(-1);
    assert.equal(rejected?.type, "run.failed");
    if (rejected?.type === "run.failed")
      assert.equal(rejected.error.code, "TOOL_EXECUTOR_CAPACITY");
    await Promise.all([stream.next(), stream.return(undefined)]);
    assert.throws(
      () =>
        driver.completeTool({
          ...identity(execution),
          output: lookup(call.arguments),
        }),
      { code: "TOOL_EXECUTION_NOT_FOUND" },
    );
    const replacement = driver.stream(request);
    await invoked(replacement);
    await replacement.return(undefined);
  },
);

test("idempotent result replay never dispatches the function a second time", async () => {
  const driver = setup({ operations: new MemoryOperationStore() });
  const input = { ...request, idempotencyKey: "application-read" };
  let count = 0;
  for await (const event of driver.stream(input))
    if (event.type === "tool.execution.requested") {
      count++;
      driver.completeTool({
        ...identity(event.execution),
        output: lookup(event.execution.call.arguments),
      });
    }
  const replay = await collect(driver.stream(input));
  assert.equal(
    replay.some((e) => e.type === "tool.execution.requested"),
    false,
  );
  assert.equal(replay.at(-1)?.type, "run.completed");
  assert.equal(count, 1);
});

test("HTTP executors use scoped grants and can report progress/results at full run capacity", async () => {
  const token = "x".repeat(32),
    restricted = "y".repeat(32);
  const server = await serve(setup(), {
    port: 0,
    maxConcurrentRuns: 1,
    tokens: [
      {
        token,
        subject: "alice",
        providers: ["mock"],
        applicationTools: [{ name: "lookup", requiresApproval: false }],
      },
      {
        token: restricted,
        subject: "alice",
        providers: ["mock"],
        tools: ["lookup"],
      },
    ],
  });
  try {
    const client = new AgenticClient({ url: server.url, token });
    assert.ok((await client.protocol()).features.includes("application-tools"));
    const denied = new AgenticClient({ url: server.url, token: restricted });
    await assert.rejects(collect(denied.stream(request)), {
      code: "FORBIDDEN",
    });
    await assert.rejects(client.run(request), { code: "TOOL_STREAM_REQUIRED" });
    const stream = client.stream(request),
      execution = await invoked(stream),
      message = identity(execution);
    await assert.rejects(
      denied.completeTool({ ...message, output: lookup(call.arguments) }),
      { code: "FORBIDDEN" },
    );
    assert.equal((await client.reportToolProgress(message)).status, "progress");
    assert.equal(
      (
        await client.completeTool({
          ...message,
          output: lookup(execution.call.arguments),
        })
      ).status,
      "accepted",
    );
    assert.equal((await collect(stream)).at(-1)?.type, "run.completed");
    await assert.rejects(
      client.completeTool({ ...message, output: lookup(call.arguments) }),
      { code: "TOOL_EXECUTION_NOT_FOUND" },
    );
  } finally {
    await server.close();
  }
});
