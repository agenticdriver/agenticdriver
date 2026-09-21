import assert from "node:assert/strict";
import test from "node:test";
import { AgenticDriver } from "../src/driver.js";
import { MemoryOperationStore } from "../src/operations.js";
import { mockProvider } from "../src/providers/mock.js";
import { UsageStatClient } from "../src/usagestat.js";
import { validateHostConfig } from "../src/host.js";
import type { UsageRecord } from "../src/types.js";

const token = "fixture-metering-backend-token-at-least-32-characters";
async function report() {
  let record!: UsageRecord;
  const driver = new AgenticDriver({
    providers: [mockProvider()],
    usage: { hostId: "host-one", accounts: { mock: "account-one" } },
    onUsage: (value) => {
      record = value;
    },
  });
  await driver.run(
    { provider: "mock", model: "demo", input: "private prompt" },
    { subject: "app-one" },
  );
  return record;
}
function receipt(record: UsageRecord, extra: object = {}) {
  return {
    schema: "usagestat.run-receipt.v1",
    hostId: record.hostId,
    eventId: record.eventId,
    status: "accepted",
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    ...extra,
  };
}

test("Usagestat capture preserves stable records across a lost acknowledgement and validates receipt identity", async () => {
  const record = await report(),
    bodies: string[] = [];
  const client = new UsageStatClient({
    token,
    fetch: async (_url, options) => {
      assert.equal(options?.redirect, "error");
      assert.equal(
        (options?.headers as Record<string, string>).Authorization,
        `Bearer ${token}`,
      );
      bodies.push(options!.body as string);
      if (bodies.length === 1)
        throw new Error("secret from transport must not escape");
      return Response.json(receipt(record, { status: "duplicate" }));
    },
  });
  await assert.rejects(
    client.capture(record),
    (error: any) =>
      error.code === "USAGESTAT_UNAVAILABLE" &&
      !error.message.includes("secret from"),
  );
  assert.equal((await client.capture(record)).status, "duplicate");
  assert.equal(bodies[0], bodies[1]);
  assert.deepEqual(JSON.parse(bodies[0]!), record);
  assert.ok(!bodies[0]!.includes("private prompt"));
  const wrong = new UsageStatClient({
    token,
    fetch: async () =>
      Response.json(receipt(record, { hostId: "different-host" })),
  });
  await assert.rejects(wrong.capture(record), { code: "USAGESTAT_SCHEMA" });
  const unbound = { ...record };
  delete unbound.accountId;
  await assert.rejects(client.capture(unbound), { code: "USAGESTAT_UNBOUND" });
  assert.equal(bodies.length, 2);
});

test("backend backpressure never retries generation or tool effects through an idempotent driver run", async () => {
  let generations = 0,
    effects = 0;
  const failures: unknown[] = [];
  const backend = new UsageStatClient({
    token,
    fetch: async () => new Response("private backend body", { status: 429 }),
  });
  const driver = new AgenticDriver({
    providers: [
      mockProvider((request) => {
        generations++;
        if (!request.messages.some((message) => message.role === "tool"))
          return {
            text: "",
            toolCalls: [{ id: "effect-once", name: "save", arguments: {} }],
          };
        return {
          text: "completed",
          usage: { inputTokens: 2, outputTokens: 1 },
        };
      }),
    ],
    tools: [
      {
        name: "save",
        description: "Fixture write",
        inputSchema: { type: "object", additionalProperties: false },
        requiresApproval: true,
        execute: () => {
          effects++;
          return { saved: true };
        },
      },
    ],
    approve: () => true,
    usage: { hostId: "host-one", accounts: { mock: "account-one" } },
    operations: new MemoryOperationStore(),
    onUsage: backend.usageSink(),
    onTelemetryError: (error) => failures.push(error),
  });
  const request = {
    provider: "mock",
    model: "demo",
    input: "work",
    idempotencyKey: "same-operation",
    tools: ["save"],
  };
  const first = await driver.run(request, { subject: "app-one" });
  const second = await driver.run(request, { subject: "app-one" });
  assert.deepEqual(second, first);
  assert.equal(generations, 2);
  assert.equal(effects, 1);
  assert.equal(failures.length, 1);
  assert.equal((failures[0] as { code: string }).code, "USAGESTAT_CAPACITY");
});

test("metering credentials and I/O are bounded and reconciliation checks the whole account identity", async () => {
  const record = await report();
  let requests = 0;
  const hanging = new UsageStatClient({
    token: () => new Promise(() => {}),
    ingestionTimeoutMs: 100,
    fetch: async () => {
      requests++;
      return Response.json({});
    },
  });
  // AbortSignal.timeout is unref'ed; retain a test handle while awaiting it.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(hanging.capture(record), {
      code: "USAGESTAT_UNAVAILABLE",
    });
  } finally {
    clearInterval(keepAlive);
  }
  assert.equal(requests, 0);
  const backend = new UsageStatClient({
    token,
    fetch: async () =>
      Response.json({
        schema: "usagestat.stored-run.v1",
        record: { ...record, accountId: "other-account" },
        expiresAt: receipt(record).expiresAt,
        delivery: "local",
        attempts: 0,
      }),
  });
  await assert.rejects(
    backend.run(
      {
        hostId: record.hostId,
        accountId: record.accountId!,
        subject: record.subject,
        provider: record.provider,
      },
      record.eventId,
    ),
    { code: "USAGESTAT_SCOPE" },
  );
  const old = new UsageStatClient({
    token,
    fetch: async () =>
      Response.json({
        schema: "usagestat.run-ingestion.v1",
        receiptSchema: "usagestat.run-receipt.v1",
        eventSchemas: ["legacy"],
        maxEventBytes: 65536,
        requiresAccount: true,
      }),
  });
  await assert.rejects(old.ingestionProtocol(), { code: "USAGESTAT_SCHEMA" });
});

test("configured usage service requires persistent account identity and secret references", () => {
  const base = {
    version: 1,
    providers: [{ kind: "mock", id: "mock", models: ["demo"] }],
    tokens: [
      {
        id: "app",
        subject: "app-one",
        providers: ["mock"],
        tokenRef: { env: "APP_TOKEN" },
      },
    ],
    usagestat: {
      url: "http://127.0.0.1:6736",
      tokenRef: { env: "USAGE_TOKEN" },
    },
  };
  assert.throws(() => validateHostConfig(base), {
    code: "USAGE_IDENTITY_REQUIRED",
  });
  const bound = {
    ...base,
    usage: { hostId: "host-one" },
    providers: [{ ...base.providers[0], accountId: "account-one" }],
  };
  assert.equal(validateHostConfig(bound).limits?.idleTimeoutMs, undefined);
  assert.throws(
    () =>
      validateHostConfig({
        ...bound,
        usagestat: { ...base.usagestat, token: "inline-secret" },
      }),
    { code: "INVALID_CONFIG" },
  );
  assert.throws(
    () =>
      validateHostConfig({
        ...bound,
        usagestat: { ...base.usagestat, url: "http://remote.example" },
      }),
    { code: "INSECURE_TRANSPORT" },
  );
});
