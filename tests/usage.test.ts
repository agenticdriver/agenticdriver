import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgenticDriver } from "../src/driver.js";
import { AgenticClient } from "../src/client.js";
import { serve } from "../src/server.js";
import { MemoryOperationStore } from "../src/operations.js";
import { DriverError } from "../src/errors.js";
import { mockProvider } from "../src/providers/mock.js";
import { anthropic, gemini } from "../src/providers/index.js";
import { createCliStream, normalizeCli } from "../src/providers/local-cli.js";
import { UsageStatClient, jsonlUsageSink } from "../src/usagestat.js";
import {
  UsageAccumulator,
  validateUsageRecord,
  usageRecordExpired,
  type UsageOptions,
} from "../src/usage.js";
import type {
  ProviderContext,
  ProviderTurn,
  UsageRecord,
} from "../src/types.js";

const request = {
  provider: "personal",
  model: "demo",
  input: "private-prompt-marker",
};
const token = "usage-test-driver-token-at-least-32-characters";
function account(id: string) {
  const provider = mockProvider(() => ({
    text: "private-output-marker",
    usage: { inputTokens: 12, outputTokens: 4 },
  }));
  return {
    ...provider,
    info: {
      ...provider.info,
      id,
      vendor: "same-vendor",
      authMode: "api-key" as const,
    },
  };
}

test("metering snapshots trusted account identity, excludes request metadata and retains identity on sink delivery", async () => {
  const policy: UsageOptions = {
    hostId: "host-one",
    accounts: { personal: "account-personal", company: "account-company" },
    labels: { app: "brandstorm" },
    retentionDays: 2,
  };
  const records: UsageRecord[] = [];
  const driver = new AgenticDriver({
    providers: [account("personal"), account("company")],
    usage: policy,
    operations: new MemoryOperationStore(),
    onUsage: (record) => {
      records.push(record);
    },
  });
  policy.accounts!.personal = "account-company";
  policy.labels!.app = "private-credentials-marker";
  const server = await serve(driver, {
    port: 0,
    tokens: [
      { token, subject: "alice", providers: ["personal"] },
      { token: token + "-bob", subject: "bob", providers: ["company"] },
    ],
  });
  try {
    const client = new AgenticClient({ url: server.url, token });
    const keyed = {
      ...request,
      idempotencyKey: "usage-once",
      metadata: {
        subject: "bob",
        accountId: "account-company",
        hostId: "attacker",
        apiKey: "private-credentials-marker",
        prompt: request.input,
      },
    };
    const first = await client.run(keyed);
    assert.equal((await client.run(keyed)).runId, first.runId);
    await assert.rejects(client.run({ ...request, provider: "company" }), {
      code: "FORBIDDEN",
    });
    await new AgenticClient({ url: server.url, token: token + "-bob" }).run({
      ...request,
      provider: "company",
    });
    assert.equal(
      records.length,
      2,
      "Idempotent replay and forbidden requests must not create another usage event",
    );
    assert.deepEqual(
      records.map((record) => [
        record.hostId,
        record.subject,
        record.accountId,
        record.provider,
      ]),
      [
        ["host-one", "alice", "account-personal", "personal"],
        ["host-one", "bob", "account-company", "company"],
      ],
    );
    const metered = records[0]!;
    assert.equal(metered.schema, "agenticdriver.usage.v2");
    assert.equal(metered.eventId, first.runId);
    assert.deepEqual(metered.metadata, { app: "brandstorm" });
    assert.equal(metered.source, "synthetic");
    assert.deepEqual(metered.coverage, {
      startedSteps: 1,
      completedSteps: 1,
      reportedSteps: { inputTokens: 1, outputTokens: 1 },
    });
    assert.equal(
      Date.parse(metered.expiresAt!) - Date.parse(metered.finishedAt),
      2 * 86_400_000,
    );
    assert.equal(
      usageRecordExpired(metered, Date.parse(metered.expiresAt!) - 1),
      false,
    );
    assert.equal(
      usageRecordExpired(metered, Date.parse(metered.expiresAt!)),
      true,
    );
    for (const record of records)
      assert.deepEqual(validateUsageRecord(record), record);
    for (const privateValue of [
      request.input,
      "private-output-marker",
      "private-credentials-marker",
      token,
    ])
      assert.equal(JSON.stringify(records).includes(privateValue), false);
  } finally {
    await server.close();
  }
});

test("unbound hosts do not invent an account or reuse a process-local identity across drivers", () => {
  const first = new AgenticDriver({ providers: [account("personal")] });
  const second = new AgenticDriver({ providers: [account("personal")] });
  assert.equal(first.usageIdentity("personal", "alice").accountId, undefined);
  assert.notEqual(
    first.usageIdentity("personal", "alice").hostId,
    second.usageIdentity("personal", "alice").hostId,
  );
  assert.throws(
    () =>
      new AgenticDriver({
        providers: [account("personal")],
        usage: { accounts: { personal: "account" } },
      }),
    { code: "USAGE_IDENTITY_REQUIRED" },
  );
  assert.throws(
    () =>
      new AgenticDriver({
        providers: [account("personal")],
        usage: { hostId: "fixed", accounts: { missing: "account" } },
      }),
    { code: "INVALID_USAGE_CONFIG" },
  );
});

test("missing or interrupted model measurements produce observed subtotals without fabricated complete totals", async () => {
  const records: UsageRecord[] = [];
  for (const mode of [
    "unknown-field",
    "missing-usage",
    "provider-failed",
  ] as const) {
    let calls = 0;
    const provider = mockProvider((): ProviderTurn => {
      if (calls++ === 0)
        return {
          text: "",
          usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 4 },
          toolCalls: [{ id: "t", name: "lookup", arguments: {} }],
        };
      if (mode === "provider-failed")
        throw new DriverError(
          "PROVIDER_FAILED",
          "The fixture provider failed.",
        );
      return {
        text: "done",
        ...(mode === "unknown-field" ? { usage: { inputTokens: 20 } } : {}),
      };
    });
    const driver = new AgenticDriver({
      providers: [provider],
      tools: [
        {
          name: "lookup",
          description: "read",
          inputSchema: { type: "object" },
          execute: () => null,
        },
      ],
      onUsage: (record) => {
        records.push(record);
      },
    });
    const operation = driver.run({
      provider: "mock",
      model: "demo",
      input: "hello",
      tools: ["lookup"],
    });
    if (mode === "provider-failed")
      await assert.rejects(operation, { code: "PROVIDER_FAILED" });
    else await operation;
  }
  assert.deepEqual(records[0]!.usage, { inputTokens: 30 });
  assert.deepEqual(records[0]!.observedUsage, {
    inputTokens: 30,
    outputTokens: 2,
    cachedInputTokens: 4,
  });
  assert.deepEqual(records[1]!.usage, {});
  assert.equal(records[1]!.coverage.completedSteps, 2);
  assert.deepEqual(records[2]!.usage, {});
  assert.deepEqual(records[2]!.observedUsage, {
    inputTokens: 10,
    outputTokens: 2,
    cachedInputTokens: 4,
  });
  assert.equal(records[2]!.coverage.startedSteps, 2);
  assert.equal(records[2]!.coverage.completedSteps, 1);
  assert.equal(records[2]!.status, "failed");
  for (const record of records) validateUsageRecord(record);
});

test("invalid numbers, overflowing sums and impossible token subsets remain unknown", () => {
  const meter = new UsageAccumulator();
  meter.start();
  assert.deepEqual(
    meter.add({
      inputTokens: 3,
      cachedInputTokens: 4,
      outputTokens: 1.5,
      reasoningTokens: -1,
      costUsd: Infinity,
      apiEquivalentCostUsd: NaN,
    }),
    { inputTokens: 3 },
  );
  meter.start();
  meter.add({
    inputTokens: Number.MAX_SAFE_INTEGER,
    outputTokens: 7,
    reasoningTokens: 2,
    costUsd: 0,
  });
  assert.deepEqual(meter.snapshot().usage, {});
  assert.equal(meter.snapshot().observedUsage.inputTokens, undefined);
  assert.equal(
    meter.snapshot().observedUsage.costUsd,
    0,
    "Explicit reported zero is distinct from unknown",
  );
  const counts = new UsageAccumulator();
  counts.start();
  assert.deepEqual(
    counts.add({
      inputTokens: 10,
      cachedInputTokens: 4,
      outputTokens: 5,
      reasoningTokens: 2,
    }),
    {
      inputTokens: 10,
      cachedInputTokens: 4,
      outputTokens: 5,
      reasoningTokens: 2,
    },
  );
  assert.equal(
    counts.snapshot().usage.inputTokens,
    10,
    "Cache is a subset, not an extra additive token charge",
  );
});

test("Claude CLI reports API-equivalent dollars separately from cost and preserves cache subsets", () => {
  const context: ProviderContext = {
    runId: "fixture",
    subject: "alice",
    signal: new AbortController().signal,
    reportProgress() {},
    emitText() {},
  };
  const stream = createCliStream("claude-code", context);
  const result = {
    type: "result",
    is_error: false,
    result: "done",
    total_cost_usd: 0.125,
    usage: {
      input_tokens: 10,
      output_tokens: 3,
      cache_read_input_tokens: 8,
      cache_creation_input_tokens: 2,
    },
  };
  stream.accept(JSON.stringify(result));
  const turn = stream.finish(JSON.stringify(result));
  assert.equal(turn.usage?.costUsd, undefined);
  assert.equal(turn.usage?.apiEquivalentCostUsd, 0.125);
  assert.equal(turn.usage?.inputTokens, 20);
  assert.equal(turn.usage?.cachedInputTokens, 8);
});

test("quota lookup requires exact host/account/provider/subject binding before network access", async () => {
  let requests = 0;
  const client = new UsageStatClient({
    url: "http://127.0.0.1:6736",
    accounts: [
      {
        hostId: "host",
        provider: "personal",
        accountId: "p",
        instanceId: "vendor-personal",
        subjects: ["alice"],
      },
      {
        hostId: "host",
        provider: "company",
        accountId: "c",
        instanceId: "vendor-company",
        subjects: ["bob"],
      },
    ],
    fetch: (async (url) => {
      requests++;
      const personal = String(url).endsWith("/v1/limits/vendor-personal");
      assert.ok(personal || String(url).endsWith("/v1/limits/vendor-company"));
      return new Response(
        JSON.stringify({
          schema: "crossusage.limits.v1",
          providers: {
            [personal ? "vendor-personal" : "vendor-company"]: {
              displayName: "same vendor",
              fetchedAt: "2026-09-21T12:00:00Z",
              resources: {
                tokens: {
                  used: personal ? 10 : 80,
                  unit: "tokens",
                  label: "Tokens",
                },
              },
            },
          },
          errors: [],
        }),
      );
    }) as typeof fetch,
  });
  const alice = {
    hostId: "host",
    provider: "personal",
    accountId: "p",
    subject: "alice",
  };
  for (const identity of [
    { ...alice, subject: "bob" },
    { ...alice, hostId: "other-host" },
    { ...alice, accountId: "c" },
    { ...alice, provider: "company" },
  ])
    await assert.rejects(client.accountLimits(identity), {
      code: "QUOTA_UNBOUND",
    });
  assert.equal(requests, 0);
  assert.equal(
    (await client.accountLimits(alice)).snapshot.resources.tokens!.used,
    10,
  );
  assert.equal(
    (
      await client.accountLimits({
        hostId: "host",
        provider: "company",
        accountId: "c",
        subject: "bob",
      })
    ).snapshot.resources.tokens!.used,
    80,
  );
  const binding = { ...alice, subjects: ["alice"], instanceId: "same" };
  const { subject: _, ...base } = binding;
  assert.throws(
    () =>
      new UsageStatClient({
        accounts: [
          base,
          { ...base, accountId: "different", provider: "company" },
        ],
      }),
    { code: "INVALID_QUOTA_BINDING" },
  );
  assert.throws(() => new UsageStatClient({ accounts: [base, base] }), {
    code: "INVALID_QUOTA_BINDING",
  });
  const missing = new UsageStatClient({
    accounts: [base],
    fetch: (async () =>
      new Response(
        JSON.stringify({
          schema: "crossusage.limits.v1",
          providers: {
            "wrong-account": {
              displayName: "same vendor",
              fetchedAt: "2026-09-21T12:00:00Z",
              resources: {},
            },
          },
          errors: [],
        }),
      )) as typeof fetch,
  });
  await assert.rejects(missing.accountLimits(alice), {
    code: "QUOTA_UNAVAILABLE",
  });
});

test("missing cache, reasoning or model counters never become a fabricated composite total", async () => {
  const api = new AgenticDriver({
    providers: [
      anthropic({
        apiKey: "fixture-only",
        fetch: (async () =>
          new Response(
            JSON.stringify({
              content: [{ type: "text", text: "done" }],
              stop_reason: "end_turn",
              usage: { input_tokens: 4, output_tokens: 2 },
            }),
          )) as typeof fetch,
      }),
      gemini({
        apiKey: "fixture-only",
        fetch: (async (_url, init) =>
          new Response(
            JSON.stringify({
              candidates: [
                {
                  content: { parts: [{ text: "done" }] },
                  finishReason: "STOP",
                },
              ],
              usageMetadata: {
                promptTokenCount: 10,
                candidatesTokenCount: 2,
                ...(String(init?.body).includes("derive-total")
                  ? { totalTokenCount: 15 }
                  : {}),
              },
            }),
          )) as typeof fetch,
      }),
    ],
  });
  assert.equal(
    (await api.run({ provider: "anthropic", model: "demo", input: "hello" }))
      .usage.inputTokens,
    undefined,
  );
  assert.equal(
    (await api.run({ provider: "gemini", model: "demo", input: "hello" })).usage
      .outputTokens,
    undefined,
  );
  const derived = (
    await api.run({ provider: "gemini", model: "demo", input: "derive-total" })
  ).usage;
  assert.equal(derived.outputTokens, 5);
  assert.equal(derived.reasoningTokens, undefined);
  const context: ProviderContext = {
    runId: "fixture",
    subject: "alice",
    signal: new AbortController().signal,
    reportProgress() {},
    emitText() {},
  };
  const raw = JSON.stringify({
    response: "done",
    stats: {
      models: {
        first: { tokens: { prompt: 3, candidates: 4, thoughts: 1 } },
        second: {},
      },
    },
  });
  assert.equal(normalizeCli("gemini-cli", raw).usage?.inputTokens, undefined);
  assert.equal(normalizeCli("gemini-cli", raw).usage?.outputTokens, undefined);
});

test("durable metering validates version and coverage, snapshots records and rejects extra private payloads", async () => {
  const records: UsageRecord[] = [];
  const driver = new AgenticDriver({
    providers: [account("personal")],
    onUsage: (record) => {
      records.push(record);
    },
  });
  await driver.run(request);
  const record = records[0]!;
  for (const malformed of [
    { ...record, schema: "agenticdriver.usage.v1" },
    { ...record, prompt: "must-not-be-stored" },
    { ...record, eventId: "00000000-0000-4000-8000-000000000000" },
    { ...record, durationMs: record.durationMs + 1 },
    { ...record, coverage: { ...record.coverage, completedSteps: 0 } },
  ])
    assert.throws(() => validateUsageRecord(malformed), {
      code: "INVALID_USAGE_RECORD",
    });
  const directory = await mkdtemp(join(tmpdir(), "agenticdriver-usage-"));
  try {
    const path = join(directory, "usage.jsonl");
    const sink = jsonlUsageSink(path);
    const pending = sink(record);
    record.metadata.secret = "must-not-be-stored";
    await pending;
    const stored = await readFile(path, "utf8");
    assert.equal(stored.includes("must-not-be-stored"), false);
    assert.equal(
      validateUsageRecord(JSON.parse(stored)).eventId,
      record.eventId,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
