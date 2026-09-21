import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as immediate } from "node:timers/promises";
import { AgenticDriver, type DriverOptions } from "../src/driver.js";
import { AgenticClient } from "../src/client.js";
import { mockProvider } from "../src/providers/mock.js";
import { MemoryOperationStore } from "../src/operations.js";
import { serve } from "../src/server.js";
import { UsageStatClient } from "../src/usagestat.js";
import {
  configuredDriver,
  configuredServer,
  validateHostConfig,
} from "../src/host.js";
import type { ProviderTurn, Usage, UsageRecord } from "../src/types.js";

const base = { provider: "mock", model: "demo", input: "private-content" };
const toolCall = { id: "lookup-one", name: "lookup", arguments: {} };
function fixture(turns: ProviderTurn[], options: Partial<DriverOptions> = {}) {
  let models = 0,
    tools = 0;
  const outputCaps: number[] = [],
    records: UsageRecord[] = [];
  const driver = new AgenticDriver({
    providers: [
      mockProvider((request) => {
        outputCaps.push(request.maxOutputTokens);
        return turns[models++]!;
      }),
    ],
    usage: { hostId: "host", accounts: { mock: "shared" } },
    tools: [
      {
        name: "lookup",
        description: "read",
        inputSchema: { type: "object" },
        execute() {
          tools++;
          return null;
        },
      },
    ],
    onUsage(record) {
      records.push(record);
    },
    ...options,
  });
  return { driver, records, outputCaps, counts: () => ({ models, tools }) };
}
const measured: Usage = { inputTokens: 3, outputTokens: 2, costUsd: 0.02 };

test("global, account and subject budgets intersect and never use request identity metadata", async () => {
  const options = {
    default: { maxTokens: 50, unknownUsage: "reject" as const },
    accounts: { shared: { maxTokens: 20, unknownUsage: "reject" as const } },
    subjects: { alice: { maxTokens: 4, unknownUsage: "reject" as const } },
  };
  const f = fixture([{ text: "answer", usage: measured }], {
    resources: options,
  });
  options.subjects.alice.maxTokens = 999;
  await assert.rejects(
    f.driver.run(
      { ...base, metadata: { subject: "bob", accountId: "other" } },
      { subject: "alice" },
    ),
    { code: "RESOURCE_LIMIT" },
  );
  assert.deepEqual(f.outputCaps, [4]);
  assert.deepEqual(f.records[0]!.usage, measured);
  assert.equal(f.records[0]!.status, "failed");
  assert.equal(f.records[0]!.accountId, "shared");
  const unbound = fixture([], {
    usage: undefined,
    resources: {
      accounts: { shared: { maxTokens: 1, unknownUsage: "reject" } },
    },
  });
  await assert.rejects(unbound.driver.run(base), {
    code: "ADMISSION_IDENTITY_REQUIRED",
  });
  assert.equal(unbound.counts().models, 0);
});

test("reported limits stop before tools or further steps, while exact final totals succeed", async () => {
  for (const mode of ["tokens", "cost"] as const) {
    const budgets = mode === "tokens" ? { maxTokens: 5 } : { maxCostUsd: 0.02 };
    const blocked = fixture(
      [{ text: "", usage: measured, toolCalls: [toolCall] }],
      { resources: { default: { ...budgets, unknownUsage: "reject" } } },
    );
    await assert.rejects(blocked.driver.run({ ...base, tools: ["lookup"] }), {
      code: "RESOURCE_LIMIT",
    });
    assert.deepEqual(blocked.counts(), { models: 1, tools: 0 });
    const final = fixture([{ text: "answer", usage: measured }], {
      resources: { default: { ...budgets, unknownUsage: "reject" } },
    });
    assert.equal((await final.driver.run(base)).text, "answer");
  }
  const cumulative = fixture(
    [
      { text: "", usage: measured, toolCalls: [toolCall] },
      {
        text: "answer",
        usage: { inputTokens: 2, outputTokens: 2, costUsd: 0.01 },
      },
    ],
    {
      resources: {
        default: { maxTokens: 9, maxCostUsd: 0.03, unknownUsage: "reject" },
      },
    },
  );
  assert.equal(
    (await cumulative.driver.run({ ...base, tools: ["lookup"] })).steps,
    2,
  );
  assert.deepEqual(cumulative.outputCaps, [9, 4]);
});

test("missing counts and API-equivalent subscription dollars remain unknown under both policies", async () => {
  for (const unknownUsage of ["reject", "allow"] as const) {
    for (const usage of [
      undefined,
      { inputTokens: 1 },
      { apiEquivalentCostUsd: 123 },
    ] as (Usage | undefined)[]) {
      const f = fixture([{ text: "answer", usage }], {
        resources: {
          default: { maxTokens: 10, maxCostUsd: 0.1, unknownUsage },
        },
      });
      const result = f.driver.run(base);
      if (unknownUsage === "reject")
        await assert.rejects(result, { code: "RESOURCE_USAGE_UNKNOWN" });
      else assert.deepEqual((await result).usage, usage ?? {});
      assert.equal(f.records[0]!.usage.costUsd, undefined);
      assert.equal(f.records[0]!.usage.outputTokens, undefined);
    }
  }
});

test("known subtotals still enforce limits when complete totals are unknown", async () => {
  const f = fixture(
    [
      { text: "", usage: { inputTokens: 4 }, toolCalls: [toolCall] },
      { text: "answer", usage: { outputTokens: 8 } },
    ],
    { resources: { default: { maxTokens: 10, unknownUsage: "allow" } } },
  );
  await assert.rejects(f.driver.run({ ...base, tools: ["lookup"] }), {
    code: "RESOURCE_LIMIT",
  });
  assert.deepEqual(f.records[0]!.usage, {});
  assert.deepEqual(f.records[0]!.observedUsage, {
    inputTokens: 4,
    outputTokens: 8,
  });
  assert.deepEqual(f.records[0]!.coverage.reportedSteps, {
    inputTokens: 1,
    outputTokens: 1,
  });
});

test("overflowing reported counters cannot evade an allow-unknown budget", async () => {
  for (const kind of ["tokens", "cost"] as const) {
    const cap = kind === "tokens" ? Number.MAX_SAFE_INTEGER : Number.MAX_VALUE;
    const first =
      kind === "tokens"
        ? { inputTokens: cap - 1, outputTokens: 0 }
        : { costUsd: cap * 0.75 };
    const next =
      kind === "tokens"
        ? { inputTokens: 2, outputTokens: 0 }
        : { costUsd: cap * 0.75 };
    const f = fixture(
      [
        { text: "", usage: first, toolCalls: [toolCall] },
        { text: "answer", usage: next },
      ],
      {
        resources: {
          default: {
            ...(kind === "tokens" ? { maxTokens: cap } : { maxCostUsd: cap }),
            unknownUsage: "allow",
          },
        },
      },
    );
    await assert.rejects(f.driver.run({ ...base, tools: ["lookup"] }), {
      code: "RESOURCE_LIMIT",
    });
    assert.equal(
      f.records[0]!.usage[kind === "tokens" ? "inputTokens" : "costUsd"],
      undefined,
    );
  }
});

test("resource hooks use trusted identity before inference, redact failures and fail closed on invalid decisions", async () => {
  for (const decision of ["deny", "unknown", "invalid", "throws"] as const) {
    const f = fixture([], {
      resourceAdmission: {
        unknown: "reject",
        authorize(context) {
          assert.deepEqual(context.identity, {
            hostId: "host",
            accountId: "shared",
            provider: "mock",
            subject: "alice",
          });
          assert.equal(context.usage.coverage.startedSteps, 0);
          assert.deepEqual(context.usage.usage, {});
          assert.equal(JSON.stringify(context).includes(base.input), false);
          if (decision === "throws") throw new Error("secret-marker");
          return decision as "deny" | "unknown";
        },
      },
    });
    await assert.rejects(
      f.driver.run(
        { ...base, metadata: { accountId: "forged" } },
        { subject: "alice" },
      ),
      (error: unknown) => {
        assert.equal((error as Error).message.includes("secret-marker"), false);
        assert.equal(
          (error as { code: string }).code,
          decision === "deny"
            ? "RESOURCE_ADMISSION_DENIED"
            : decision === "unknown"
              ? "RESOURCE_USAGE_UNKNOWN"
              : "RESOURCE_POLICY_UNAVAILABLE",
        );
        return true;
      },
    );
    assert.equal(f.counts().models, 0);
  }
});

test("external admission sees step coverage and is not reissued for an idempotent replay", async () => {
  const seen: number[] = [];
  const f = fixture(
    [{ text: "", usage: measured, toolCalls: [toolCall] }, { text: "done" }],
    {
      operations: new MemoryOperationStore(),
      resourceAdmission: {
        unknown: "allow",
        authorize(context) {
          seen.push(context.step);
          if (context.step === 2)
            assert.deepEqual(context.usage.usage, measured);
          return "unknown";
        },
      },
    },
  );
  const request = { ...base, tools: ["lookup"], idempotencyKey: "policy-once" };
  const first = await f.driver.run(request);
  assert.equal((await f.driver.run(request)).runId, first.runId);
  assert.deepEqual(seen, [1, 2]);
  assert.equal(f.records.length, 1);
});

test("pending resource authority can be cancelled and never gains an implicit execution deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let entered = false;
  const f = fixture([], {
    resourceAdmission: {
      unknown: "reject",
      authorize() {
        entered = true;
        return new Promise(() => {});
      },
    },
  });
  const controller = new AbortController();
  const events = f.driver.stream(
    { ...base, idleTimeoutMs: 10 },
    { signal: controller.signal },
  );
  await events.next();
  const next = events.next();
  await immediate();
  assert.ok(entered);
  t.mock.timers.tick(7 * 86_400_000);
  await immediate();
  controller.abort();
  const outcome = (await next).value!;
  assert.equal(outcome.type, "run.cancelled");
  assert.equal(
    outcome.type === "run.cancelled" && outcome.error.code,
    "CANCELLED",
  );
  await events.return(undefined);
  assert.equal(f.counts().models, 0);
});

test("host JSON validates policies, account bindings and exposes typed policy rejections over HTTP", async () => {
  const input = {
    version: 1,
    listen: { port: 0 },
    usage: { hostId: "host" },
    providers: [
      { kind: "mock", id: "mock", models: ["demo"], accountId: "shared" },
    ],
    tokens: [
      {
        id: "app",
        subject: "alice",
        providers: ["mock"],
        tokenRef: { env: "FIXTURE" },
      },
    ],
    concurrency: {
      total: 1,
      perAccount: 1,
      queue: { total: 3, perSubject: 1 },
    },
    resources: {
      accounts: { shared: { maxTokens: 10, unknownUsage: "reject" } },
    },
  };
  const config = validateHostConfig(input);
  const reserved = JSON.parse(
    '{"subjects":{"__proto__":{"maxTokens":1,"unknownUsage":"reject"}}}',
  );
  assert.throws(() => validateHostConfig({ ...input, resources: reserved }), {
    code: "INVALID_CONFIG",
  });
  assert.throws(() => fixture([], { resources: reserved }), {
    code: "INVALID_RESOURCE_POLICY",
  });
  assert.throws(
    () =>
      fixture([], { scheduling: JSON.parse('{"subjects":{"__proto__":1}}') }),
    { code: "INVALID_SCHEDULING" },
  );
  assert.throws(
    () =>
      validateHostConfig({
        ...input,
        resources: { default: { maxTokens: 1 } },
      }),
    { code: "INVALID_CONFIG" },
  );
  assert.throws(
    () =>
      validateHostConfig({
        ...input,
        providers: [{ ...input.providers[0], accountId: undefined }],
      }),
    { code: "ADMISSION_IDENTITY_REQUIRED" },
  );
  assert.throws(
    () =>
      validateHostConfig({
        ...input,
        resources: {
          accounts: { typo: { maxTokens: 10, unknownUsage: "reject" } },
        },
      }),
    { code: "INVALID_CONFIG" },
  );
  const token = "resource-policy-fixture-at-least-32-characters";
  const driver = configuredDriver(config, "/tmp/resource-host.json", {
    resourceAdmission: { unknown: "reject", authorize: () => "deny" },
  });
  const server = await serve(
    driver,
    await configuredServer(
      config,
      "/tmp/resource-host.json",
      async () => token,
    ),
  );
  try {
    const client = new AgenticClient({ url: server.url, token });
    await assert.rejects(client.run(base), {
      code: "RESOURCE_ADMISSION_DENIED",
      retryable: false,
    });
    const events = [];
    for await (const event of client.stream(base)) events.push(event);
    assert.equal(events[0]!.type, "run.started");
    assert.equal(events.at(-1)!.type, "run.failed");
    const response = await fetch(server.url + "/v1/runs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(base),
    });
    assert.equal(response.status, 403);
  } finally {
    await server.close();
  }
});

test("Usagestat admission reuses scoped quota snapshots with explicit freshness, units and unknown behavior", async () => {
  let requests = 0;
  const resource = {
    used: 10,
    limit: 100,
    remaining: 90,
    unit: "tokens",
    label: "Tokens",
  };
  let snapshot: Record<string, unknown> = {
    displayName: "account",
    fetchedAt: new Date().toISOString(),
    resources: { tokens: resource },
  };
  const backend = new UsageStatClient({
    accounts: [
      {
        hostId: "host",
        provider: "mock",
        accountId: "shared",
        instanceId: "upstream",
        subjects: ["alice"],
      },
    ],
    fetch: (async (url, init) => {
      requests++;
      assert.equal(new URL(String(url)).pathname, "/v1/limits/upstream");
      assert.ok(init?.signal);
      return new Response(
        JSON.stringify({
          schema: "crossusage.limits.v1",
          providers: { upstream: snapshot },
          errors: [],
        }),
      );
    }) as typeof fetch,
  });
  const policy = backend.quotaAdmission({
    resource: "tokens",
    unit: "tokens",
    minimumRemaining: 5,
    maxAgeMs: 60_000,
    unknown: "reject",
  });
  const context = {
    identity: {
      hostId: "host",
      provider: "mock",
      accountId: "shared",
      subject: "alice",
    },
    runId: "test",
    model: "demo",
    step: 1,
    usage: {
      usage: {},
      observedUsage: {},
      coverage: { startedSteps: 0, completedSteps: 0, reportedSteps: {} },
    },
    signal: new AbortController().signal,
  };
  assert.equal(await policy.authorize(context), "allow");
  for (const patch of [
    { resources: { tokens: { ...resource, remaining: 0 } } },
    { resources: { tokens: { ...resource, remaining: -1 } } },
  ]) {
    snapshot = {
      displayName: "account",
      fetchedAt: new Date().toISOString(),
      ...patch,
    };
    assert.equal(await policy.authorize(context), "deny");
  }
  for (const patch of [
    { fetchedAt: new Date(Date.now() - 120_000).toISOString() },
    { fetchedAt: new Date(Date.now() + 120_000).toISOString() },
    { resources: { tokens: { ...resource, remaining: undefined } } },
    { resources: { tokens: { ...resource, unit: "requests" } } },
    { resources: { tokens: { ...resource, remaining: 101 } } },
    {
      resources: {
        tokens: {
          ...resource,
          resetsAt: new Date(Date.now() - 1000).toISOString(),
        },
      },
    },
    { resources: {} },
    { source: "error" },
  ]) {
    snapshot = {
      displayName: "account",
      fetchedAt: new Date().toISOString(),
      resources: { tokens: resource },
      ...patch,
    };
    assert.equal(await policy.authorize(context), "unknown");
  }
  const before = requests;
  await assert.rejects(
    Promise.resolve(
      policy.authorize({
        ...context,
        identity: { ...context.identity, subject: "bob" },
      }),
    ),
    { code: "QUOTA_UNBOUND" },
  );
  assert.equal(requests, before);
  snapshot = {
    displayName: "account",
    fetchedAt: new Date().toISOString(),
    resources: { tokens: { ...resource, remaining: 0 } },
  };
  const f = fixture([], { resourceAdmission: policy });
  await assert.rejects(f.driver.run(base, { subject: "alice" }), {
    code: "RESOURCE_ADMISSION_DENIED",
  });
  assert.equal(f.counts().models, 0);
});

test("Usagestat quota admission propagates cancellation to the backend read", async () => {
  let networkSignal: AbortSignal | undefined;
  const backend = new UsageStatClient({
    accounts: [
      {
        hostId: "host",
        provider: "mock",
        accountId: "shared",
        instanceId: "upstream",
        subjects: ["alice"],
      },
    ],
    fetch: (async (_url, init) => {
      networkSignal = init?.signal ?? undefined;
      return new Promise(() => {});
    }) as typeof fetch,
  });
  const f = fixture([], {
    resourceAdmission: backend.quotaAdmission({
      resource: "tokens",
      unit: "tokens",
      minimumRemaining: 1,
      maxAgeMs: 60_000,
      unknown: "reject",
    }),
  });
  const controller = new AbortController();
  const operation = f.driver.run(base, {
    subject: "alice",
    signal: controller.signal,
  });
  const failed = assert.rejects(operation, { code: "CANCELLED" });
  await immediate();
  assert.ok(networkSignal);
  controller.abort();
  await failed;
  assert.equal(networkSignal.aborted, true);
  assert.equal(f.counts().models, 0);
});
