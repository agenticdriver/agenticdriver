import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as immediate } from "node:timers/promises";
import { AgenticDriver, type DriverOptions } from "../src/driver.js";
import { AgenticClient } from "../src/client.js";
import { mockProvider } from "../src/providers/mock.js";
import { serve } from "../src/server.js";
import { MemoryOperationStore } from "../src/operations.js";
import type {
  ApprovalRequest,
  RunEvent,
  RunRequest,
  UsageRecord,
} from "../src/types.js";
import type { ApprovalAuditRecord } from "../src/approvals.js";

const request: RunRequest = {
  provider: "mock",
  model: "demo",
  input: "Propose an action",
  tools: ["write"],
  approvals: { mode: "interactive", idlePolicy: "pause" },
};
const call = {
  id: "call-one",
  name: "write",
  arguments: { nested: { text: "Reviewed 🌍", ids: [1, 2] } },
};
function setup(options: Partial<DriverOptions> = {}) {
  const effects: unknown[] = [],
    audit: ApprovalAuditRecord[] = [],
    usage: UsageRecord[] = [];
  const provider = mockProvider((input) =>
    input.messages.some((m) => m.role === "tool")
      ? { text: "done", usage: { inputTokens: 1, outputTokens: 1 } }
      : {
          text: "proposal",
          toolCalls: [call],
          usage: { inputTokens: 2, outputTokens: 3 },
        },
  );
  const driver = new AgenticDriver({
    providers: [provider],
    tools: [
      {
        name: "write",
        description: "An app-owned write",
        requiresApproval: true,
        inputSchema: { type: "object" },
        execute(input) {
          effects.push(input);
          return { saved: true };
        },
      },
    ],
    approvals: {
      interactive: true,
      onAudit: (event) => {
        audit.push(event);
      },
    },
    onUsage: (record) => {
      usage.push(record);
    },
    ...options,
  });
  return { driver, effects, audit, usage };
}
async function proposed(
  stream: AsyncGenerator<RunEvent>,
): Promise<ApprovalRequest> {
  for (;;) {
    const item = await stream.next();
    assert.equal(item.done, false);
    if (item.value?.type === "approval.requested") return item.value.approval;
    assert.notEqual(item.value?.type, "run.failed");
  }
}
function decision(
  approval: ApprovalRequest,
  action: "approve" | "deny" | "cancel" = "approve",
) {
  return {
    approvalId: approval.approvalId,
    runId: approval.runId,
    call: structuredClone(approval.call),
    decision: action,
  };
}
async function collect(stream: AsyncGenerator<RunEvent>) {
  const events: RunEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

test("approval binds subject, run and exact call; altered/duplicate decisions cannot execute", async () => {
  const { driver, effects, audit, usage } = setup();
  const stream = driver.stream(request, { subject: "alice" });
  const approval = await proposed(stream),
    input = decision(approval);
  assert.deepEqual(effects, []);
  assert.throws(() => driver.decideApproval(input, { subject: "bob" }), {
    code: "APPROVAL_NOT_FOUND",
  });
  for (const altered of [
    { ...input, runId: "other" },
    { ...input, call: { ...input.call, id: "other" } },
    { ...input, call: { ...input.call, name: "other" } },
    {
      ...input,
      call: {
        ...input.call,
        arguments: { nested: { text: "Unreviewed", ids: [1, 2] } },
      },
    },
  ])
    assert.throws(() => driver.decideApproval(altered, { subject: "alice" }), {
      code: "APPROVAL_MISMATCH",
    });
  const receipt = driver.decideApproval(input, { subject: "alice" });
  assert.equal(receipt.outcome, "approved");
  assert.deepEqual(effects, []); // Receipt is authorization, not a tool result.
  assert.throws(() => driver.decideApproval(input, { subject: "alice" }), {
    code: "APPROVAL_NOT_FOUND",
  });
  const events = await collect(stream);
  assert.equal(events[0]?.type, "approval.resolved");
  assert.equal(events.at(-1)?.type, "run.completed");
  assert.deepEqual(effects, [call.arguments]);
  assert.equal(audit.filter((e) => e.type === "approval.rejected").length, 6);
  assert.equal(audit.filter((e) => e.type === "approval.resolved").length, 1);
  assert.equal(usage[0]?.status, "completed");
});

test("denial and cancellation are terminal, audited and produce no tool effects", async () => {
  for (const action of ["deny", "cancel"] as const) {
    const { driver, effects, audit, usage } = setup();
    const stream = driver.stream(request),
      approval = await proposed(stream);
    driver.decideApproval(decision(approval, action));
    for await (const event of stream) {
      if (event.type === "approval.resolved")
        event.resolution.outcome = "approved"; // Mutating UI state cannot grant permission.
      if (event.type === "run.failed" || event.type === "run.cancelled") {
        assert.equal(
          event.type,
          action === "deny" ? "run.failed" : "run.cancelled",
        );
        assert.equal(
          event.error.code,
          action === "deny" ? "APPROVAL_DENIED" : "CANCELLED",
        );
        assert.equal(event.error.outcome, undefined);
      }
    }
    assert.deepEqual(effects, []);
    assert.equal(usage[0]?.status, action === "deny" ? "failed" : "cancelled");
    assert.equal(audit.at(-1)?.type, "approval.resolved");
    assert.throws(() => driver.decideApproval(decision(approval)), {
      code: "APPROVAL_NOT_FOUND",
    });
  }
});

test("no default human deadline; pause policy suspends only explicit inactivity accounting", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { driver, effects } = setup({ limits: { idleTimeoutMs: 50 } });
  const stream = driver.stream(request),
    approval = await proposed(stream);
  assert.equal(approval.expiresAt, undefined);
  t.mock.timers.tick(30 * 86_400_000);
  await immediate();
  driver.decideApproval(decision(approval));
  assert.equal((await collect(stream)).at(-1)?.type, "run.completed");
  assert.equal(effects.length, 1);
});

test("continue policy applies configured idle timeout; human review does not emit progress", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { driver, effects, audit } = setup();
  const stream = driver.stream({
    ...request,
    idleTimeoutMs: 50,
    approvals: { mode: "interactive", idlePolicy: "continue" },
  });
  const approval = await proposed(stream);
  t.mock.timers.tick(51);
  const events = await collect(stream),
    last = events.at(-1);
  assert.equal(
    events.some((e) => e.type === "run.progress"),
    false,
  );
  assert.equal(last?.type, "run.cancelled");
  if (last?.type === "run.cancelled")
    assert.equal(last.error.code, "IDLE_TIMEOUT");
  assert.deepEqual(effects, []);
  assert.equal(audit.at(-1)?.type, "approval.resolved");
  assert.throws(() => driver.decideApproval(decision(approval)), {
    code: "APPROVAL_NOT_FOUND",
  });
});

test("the activity clock resumes at the decision even if the local consumer stops reading", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { driver, effects } = setup({ limits: { idleTimeoutMs: 50 } });
  const stream = driver.stream(request),
    approval = await proposed(stream);
  driver.decideApproval(decision(approval));
  await immediate();
  t.mock.timers.tick(51);
  const last = (await collect(stream)).at(-1);
  assert.equal(last?.type, "run.cancelled");
  if (last?.type === "run.cancelled")
    assert.equal(last.error.code, "IDLE_TIMEOUT");
  assert.deepEqual(effects, []);
});

test("application expiry fails closed including a late decision before the timer fires", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  for (const dispatchTimer of [false, true]) {
    const { driver, effects, audit } = setup();
    const stream = driver.stream({
      ...request,
      approvals: { ...request.approvals!, expiresAfterMs: 50 },
    });
    const approval = await proposed(stream);
    assert.ok(approval.expiresAt);
    if (dispatchTimer) t.mock.timers.tick(51);
    else t.mock.timers.setTime(Date.now() + 51);
    assert.throws(() => driver.decideApproval(decision(approval)), {
      code: "APPROVAL_NOT_FOUND",
    });
    const last = (await collect(stream)).at(-1);
    assert.equal(last?.type, "run.failed");
    if (last?.type === "run.failed")
      assert.equal(last.error.code, "APPROVAL_EXPIRED");
    assert.deepEqual(effects, []);
    assert.ok(
      audit.some(
        (e) =>
          e.type === "approval.resolved" && e.resolution.outcome === "expired",
      ),
    );
  }
});

test("abort and early stream return invalidate the pending request and release capacity", async () => {
  for (const abort of [false, true]) {
    const audit: ApprovalAuditRecord[] = [];
    const { driver, effects } = setup({
      approvals: {
        interactive: true,
        maxPending: 1,
        onAudit: (e) => {
          audit.push(e);
        },
      },
    });
    const controller = new AbortController(),
      stream = driver.stream(request, { signal: controller.signal });
    const approval = await proposed(stream);
    const competing = await collect(driver.stream(request));
    const failure = competing.at(-1);
    assert.equal(failure?.type, "run.failed");
    if (failure?.type === "run.failed")
      assert.equal(failure.error.code, "APPROVAL_CAPACITY");
    if (abort) {
      controller.abort();
      await collect(stream);
    } else await stream.return(undefined);
    assert.throws(() => driver.decideApproval(decision(approval)), {
      code: "APPROVAL_NOT_FOUND",
    });
    assert.ok(
      audit.some(
        (e) =>
          e.type === "approval.resolved" &&
          e.resolution.outcome === "cancelled",
      ),
    );
    const next = driver.stream(request);
    await proposed(next);
    await next.return(undefined);
    assert.deepEqual(effects, []);
  }
});

test("host opt-in, host policy and existing approval callback cannot be bypassed", async () => {
  for (const options of [
    { approvals: undefined },
    { approvals: { interactive: true as const, allowIdlePause: false } },
  ]) {
    const { driver, effects } = setup(options);
    await assert.rejects(collect(driver.stream(request)), {
      code: options.approvals ? "APPROVAL_POLICY" : "APPROVAL_UNAVAILABLE",
    });
    assert.deepEqual(effects, []);
  }
  const { driver, effects } = setup({ approve: () => false });
  const events = await collect(driver.stream(request));
  assert.equal(
    events.some((e) => e.type === "approval.requested"),
    false,
  );
  const last = events.at(-1);
  if (last?.type === "run.failed")
    assert.equal(last.error.code, "APPROVAL_REQUIRED");
  assert.deepEqual(effects, []);
  await assert.rejects(driver.run(request), {
    code: "APPROVAL_STREAM_REQUIRED",
  });
});

test("approval event snapshots cannot alter the approved action", async () => {
  const { driver, effects } = setup({
    approve: (value) => {
      value.arguments = { injected: true };
      return true;
    },
  });
  const stream = driver.stream(request);
  for await (const event of stream) {
    if (event.type === "tool.called") event.call.arguments = { injected: true };
    if (event.type === "approval.requested") {
      const reviewed = decision(event.approval);
      event.approval.call.arguments = { injected: true };
      driver.decideApproval(reviewed);
    }
  }
  assert.deepEqual(effects, [call.arguments]);
});

test("normalization cannot hide JSON arguments in a proposal or a remote decision", async () => {
  const special = JSON.parse(
    '{"__proto__":{"hidden":"must not disappear"},"visible":true}',
  );
  const { driver, effects, audit } = setup();
  const stream = driver.stream(request),
    approval = await proposed(stream);
  const server = await serve(driver, {
    port: 0,
    tokens: [
      {
        token: "v".repeat(32),
        subject: "local",
        providers: ["mock"],
        approveTools: ["write"],
      },
    ],
  });
  try {
    const input = decision(approval);
    input.call.arguments = special;
    await assert.rejects(
      new AgenticClient({
        url: server.url,
        token: "v".repeat(32),
      }).decideApproval(input),
      { code: "INVALID_APPROVAL" },
    );
    assert.ok(
      audit.some(
        (e) => e.type === "approval.rejected" && e.code === "INVALID_APPROVAL",
      ),
    );
    driver.decideApproval(decision(approval, "deny"));
    await collect(stream);
    assert.deepEqual(effects, []);
  } finally {
    await server.close();
  }
  const malformed = setup({
    providers: [
      mockProvider(() => ({
        text: "",
        toolCalls: [{ ...call, arguments: special }],
      })),
    ],
  });
  const events = await collect(malformed.driver.stream(request));
  assert.equal(
    events.some((e) => e.type === "approval.requested"),
    false,
  );
  const last = events.at(-1);
  assert.equal(last?.type, "run.failed");
  if (last?.type === "run.failed")
    assert.equal(last.error.code, "INVALID_TOOL_CALL");
  assert.deepEqual(malformed.effects, []);
});

test("disconnect and host shutdown revoke pending remote approvals", async () => {
  for (const shutdown of [false, true]) {
    const { driver, effects, audit } = setup();
    const token = "d".repeat(32);
    const server = await serve(driver, {
      port: 0,
      tokens: [
        {
          token,
          subject: "alice",
          providers: ["mock"],
          tools: ["write"],
          approveTools: ["write"],
        },
      ],
    });
    const client = new AgenticClient({ url: server.url, token });
    const stream = client.stream(request),
      approval = await proposed(stream);
    try {
      if (shutdown) await server.close();
      else await stream.return(undefined);
      for (
        let attempt = 0;
        attempt < 100 && !audit.some((e) => e.type === "approval.resolved");
        attempt++
      )
        await immediate();
      assert.ok(
        audit.some(
          (e) =>
            e.type === "approval.resolved" &&
            e.resolution.outcome === "cancelled",
        ),
      );
      assert.throws(
        () => driver.decideApproval(decision(approval), { subject: "alice" }),
        { code: "APPROVAL_NOT_FOUND" },
      );
      assert.deepEqual(effects, []);
    } finally {
      await stream.return(undefined);
      await server.close();
    }
  }
});

test(
  "closing a stream interrupts an already pending approval read without any deadline",
  { timeout: 2000 },
  async () => {
    const { driver, effects } = setup();
    const local = driver.stream(request);
    const approval = await proposed(local);
    const localRead = local.next();
    const localClose = local.return(undefined);
    await Promise.all([localRead, localClose]);
    assert.throws(() => driver.decideApproval(decision(approval)), {
      code: "APPROVAL_NOT_FOUND",
    });
    const token = "c".repeat(32);
    const server = await serve(driver, {
      port: 0,
      tokens: [
        {
          token,
          subject: "remote",
          providers: ["mock"],
          tools: ["write"],
          approveTools: ["write"],
        },
      ],
    });
    try {
      const stream = new AgenticClient({ url: server.url, token }).stream(
        request,
      );
      await proposed(stream);
      const read = assert.rejects(
        stream.next(),
        (error: unknown) =>
          error instanceof Error && error.name === "AbortError",
      );
      await stream.return(undefined);
      await read;
    } finally {
      await server.close();
    }
    assert.deepEqual(effects, []);
  },
);

test("audit failures fail closed and do not leave executable pending approvals", async () => {
  for (const failedType of ["approval.requested", "approval.resolved"]) {
    const { driver, effects } = setup({
      approvals: {
        interactive: true,
        onAudit: (e) => {
          if (e.type === failedType) throw new Error("private secret");
        },
      },
    });
    const events: RunEvent[] = [];
    for await (const event of driver.stream(request)) {
      events.push(event);
      if (event.type === "approval.requested") {
        assert.throws(() => driver.decideApproval(decision(event.approval)), {
          code: "APPROVAL_AUDIT_FAILED",
        });
        assert.throws(() => driver.decideApproval(decision(event.approval)), {
          code: "APPROVAL_NOT_FOUND",
        });
      }
    }
    const last = events.at(-1);
    assert.equal(last?.type, "run.failed");
    if (last?.type === "run.failed")
      assert.equal(last.error.code, "APPROVAL_AUDIT_FAILED");
    assert.equal(JSON.stringify(events).includes("private secret"), false);
    assert.deepEqual(effects, []);
  }
});

test("idempotent replay retains audit storage but never issues another approval or action", async () => {
  const operations = new MemoryOperationStore();
  const { driver, effects } = setup({ operations });
  const input = { ...request, idempotencyKey: "write-once" };
  let approval!: ApprovalRequest;
  for await (const event of driver.stream(input)) {
    if (event.type === "approval.requested") {
      approval = event.approval;
      driver.decideApproval(decision(approval));
    }
  }
  const replay = await collect(driver.stream(input));
  assert.equal(
    replay.some((e) => e.type.startsWith("approval.")),
    false,
  );
  assert.equal(replay.at(-1)?.type, "run.completed");
  assert.equal(effects.length, 1);
  assert.throws(() => driver.decideApproval(decision(approval)), {
    code: "APPROVAL_NOT_FOUND",
  });
});

test("interrupted approval remains an idempotency barrier after host recreation", async () => {
  const operations = new MemoryOperationStore();
  const original = setup({ operations });
  const input = { ...request, idempotencyKey: "interrupted-review" };
  const stream = original.driver.stream(input),
    approval = await proposed(stream);
  await stream.return(undefined);
  const restarted = setup({ operations });
  assert.throws(() => restarted.driver.decideApproval(decision(approval)), {
    code: "APPROVAL_NOT_FOUND",
  });
  const replay = await collect(restarted.driver.stream(input));
  assert.equal(
    replay.some((e) => e.type.startsWith("approval.")),
    false,
  );
  const last = replay.at(-1);
  assert.equal(last?.type, "run.failed");
  if (last?.type === "run.failed")
    assert.equal(last.error.code, "OPERATION_UNCERTAIN");
  assert.deepEqual([...original.effects, ...restarted.effects], []);
});

test("async audit handlers are rejected before asking for permission", async () => {
  const { driver, effects } = setup({
    approvals: { interactive: true, onAudit: async () => {} },
  });
  const events = await collect(driver.stream(request));
  const last = events.at(-1);
  assert.equal(last?.type, "run.failed");
  if (last?.type === "run.failed")
    assert.equal(last.error.code, "APPROVAL_AUDIT_FAILED");
  assert.equal(
    events.some((event) => event.type === "approval.requested"),
    false,
  );
  assert.deepEqual(effects, []);
});

test("remote decisions require their subject and separate tool/provider grants even at run capacity", async () => {
  const { driver, effects } = setup();
  const token = "a".repeat(32),
    noGrant = "n".repeat(32),
    wrongProvider = "p".repeat(32),
    otherSubject = "b".repeat(32);
  const server = await serve(driver, {
    port: 0,
    maxConcurrentRuns: 1,
    maxConcurrentRunsPerSubject: 1,
    tokens: [
      {
        token,
        subject: "alice",
        providers: ["mock"],
        tools: ["write"],
        approveTools: ["write"],
      },
      {
        token: noGrant,
        subject: "alice",
        providers: ["mock"],
        tools: ["write"],
      },
      {
        token: wrongProvider,
        subject: "alice",
        providers: [],
        approveTools: ["write"],
      },
      {
        token: otherSubject,
        subject: "bob",
        providers: ["mock"],
        tools: ["write"],
        approveTools: ["write"],
      },
    ],
  });
  try {
    const client = new AgenticClient({ url: server.url, token });
    assert.ok(
      (await client.protocol()).features.includes("interactive-approvals"),
    );
    await assert.rejects(client.run(request), {
      code: "APPROVAL_STREAM_REQUIRED",
    });
    const stream = client.stream(request),
      approval = await proposed(stream),
      input = decision(approval);
    for (const [token, code] of [
      [noGrant, "FORBIDDEN"],
      [wrongProvider, "FORBIDDEN"],
      [otherSubject, "APPROVAL_NOT_FOUND"],
    ]) {
      await assert.rejects(
        new AgenticClient({ url: server.url, token: token! }).decideApproval(
          input,
        ),
        { code },
      );
    }
    assert.deepEqual(effects, []);
    assert.equal((await client.decideApproval(input)).outcome, "approved");
    assert.equal((await collect(stream)).at(-1)?.type, "run.completed");
    await assert.rejects(client.decideApproval(input), {
      code: "APPROVAL_NOT_FOUND",
    });
    assert.equal(effects.length, 1);
    const json = await fetch(server.url + "/v1/runs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });
    assert.equal(json.status, 400);
    assert.equal(effects.length, 1);
  } finally {
    await server.close();
  }
});
