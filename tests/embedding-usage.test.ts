import assert from "node:assert/strict";
import test from "node:test";
import { AgenticDriver } from "../src/driver.js";
import {
  RetrievalService,
  MemoryVectorStore,
  DeterministicEmbeddingAdapter,
} from "../src/retrieval.js";
import { mockProvider } from "../src/providers/index.js";
import { UsageRecordSchema, validateUsageRecord } from "../src/usage.js";
import { DriverError } from "../src/errors.js";
import type { ExecutionContext, UsageRecord } from "../src/types.js";

const identity = {
  providerId: "research-embedding",
  vendor: "embedding-fixture",
  accountId: "embedding-account",
  authMode: "api-key" as const,
  model: "embedding-model",
  dimensions: 16,
};
const ctx: ExecutionContext = {
  runId: "a145b1f7-354d-4b50-aeae-85e3cb0e2b3e",
  subject: "alice",
  signal: new AbortController().signal,
  reportProgress() {},
};
const document = {
  corpus: "library",
  source: { id: "paper", revision: "r1" },
  chunks: [1, 2, 3].map((i) => ({
    id: `p${i}`,
    text: `Private evidence ${i}`,
  })),
};

test("embedding batches and query emit separate account-bound v2 events through the existing usage contract", async () => {
  const records: UsageRecord[] = [],
    generation: UsageRecord[] = [],
    fixture = new DeterministicEmbeddingAdapter(16);
  const batches: number[] = [];
  const retrieval = new RetrievalService(
    [
      {
        id: "library",
        version: "v1",
        store: new MemoryVectorStore(),
        embedding: {
          info: identity,
          usageSource: "provider-response",
          async embed(texts, context) {
            batches.push(texts.length);
            return {
              ...(await fixture.embed(texts, context)),
              usage: { inputTokens: texts.length * 7 },
            };
          },
        },
        authorize: () => ({ namespace: "alice", sources: { paper: "r1" } }),
      },
    ],
    {
      embeddingBatch: { maxTexts: 2 },
      usage: {
        hostId: "host",
        labels: { application: "library", operation: "caller-label" },
        onUsage: (record) => {
          records.push(validateUsageRecord(record));
        },
      },
    },
  );
  const driver = new AgenticDriver({
    retrieval,
    providers: [
      mockProvider(() => ({
        text: "answer",
        usage: { inputTokens: 20, outputTokens: 4 },
      })),
    ],
    usage: { hostId: "host", accounts: { mock: "generation-account" } },
    onUsage: (record) => {
      generation.push(record);
    },
  });
  await retrieval.index(document, ctx);
  assert.deepEqual(batches, [2, 1]);
  await retrieval.index(document, ctx); // identical revision performs no extra embedding or telemetry
  assert.deepEqual(batches, [2, 1]);
  const result = await driver.run(
    {
      provider: "mock",
      model: "demo",
      input: "Private evidence",
      retrieval: { corpus: "library", sourceIds: ["paper"] },
      metadata: { accountId: "forged", email: "private@example.test" },
    },
    { subject: "alice" },
  );
  assert.equal(records.length, 3);
  assert.equal(generation.length, 1);
  assert.deepEqual(batches, [2, 1, 1]);
  assert.equal(result.usage.inputTokens, 20);
  assert.equal(generation[0]!.usage.inputTokens, 20);
  assert.equal(generation[0]!.accountId, "generation-account");
  assert.equal(
    records.reduce((sum, record) => sum + record.usage.inputTokens!, 0),
    28,
  );
  assert.equal(new Set(records.map((record) => record.eventId)).size, 3);
  for (const record of records) {
    assert.ok(UsageRecordSchema.safeParse(record).success);
    assert.equal(record.accountId, "embedding-account");
    assert.equal(record.hostId, "host");
    assert.equal(record.provider, "research-embedding");
    assert.equal(record.model, "embedding-model");
    assert.equal(record.authMode, "api-key");
    assert.equal(record.source, "provider-response");
    assert.equal(record.eventId, record.runId);
    assert.notEqual(record.runId, result.runId);
    assert.equal(record.metadata.operation, "embedding");
    assert.equal(record.metadata.application, "library");
    assert.equal(record.coverage.startedSteps, 1);
    assert.equal(record.coverage.completedSteps, 1);
    assert.equal(record.usage.outputTokens, undefined);
    assert.ok(!JSON.stringify(record).includes("Private evidence"));
    assert.ok(!JSON.stringify(record).includes("private@example.test"));
  }
  assert.equal(records[0]!.metadata.purpose, "index");
  assert.equal(records[0]!.metadata.parentRunId, ctx.runId);
  assert.equal(records[2]!.metadata.purpose, "query");
  assert.equal(records[2]!.metadata.parentRunId, result.runId);
});

test("failed later embedding batch records known charges and leaves the previous index intact", async () => {
  const records: UsageRecord[] = [],
    fixture = new DeterministicEmbeddingAdapter(16),
    store = new MemoryVectorStore();
  let revision = "r1",
    calls = 0,
    fail = false;
  const retrieval = new RetrievalService(
    [
      {
        id: "library",
        version: "v1",
        store,
        embedding: {
          info: identity,
          async embed(texts, context) {
            calls++;
            if (fail && calls % 2 === 0)
              throw new DriverError("EMBEDDING_FAILED", "Fixture failure");
            return {
              ...(await fixture.embed(texts, context)),
              usage: { inputTokens: 9 },
            };
          },
        },
        authorize: () => ({ namespace: "alice", sources: { paper: revision } }),
      },
    ],
    {
      embeddingBatch: { maxTexts: 2 },
      usage: {
        hostId: "host",
        onUsage: (record) => {
          records.push(validateUsageRecord(record));
        },
      },
    },
  );
  await retrieval.index(document, ctx);
  revision = "r2";
  fail = true;
  await assert.rejects(
    retrieval.index(
      { ...document, source: { ...document.source, revision } },
      ctx,
    ),
    { code: "EMBEDDING_FAILED" },
  );
  assert.deepEqual(
    records.map((record) => record.status),
    ["completed", "completed", "completed", "failed"],
  );
  assert.deepEqual(records[3]!.usage, {});
  assert.equal(records[3]!.coverage.completedSteps, 0);
  assert.equal(records[2]!.usage.inputTokens, 9);
  assert.equal(
    (
      await store.documents(
        { corpus: "library", namespace: "alice", sources: { paper: "r1" } },
        ctx,
      )
    )[0]!.revision,
    "r1",
  );
});

test("usage sink failure does not rerun or roll back an indexed document", async () => {
  const fixture = new DeterministicEmbeddingAdapter(16);
  let calls = 0,
    errors = 0;
  const retrieval = new RetrievalService(
    [
      {
        id: "library",
        version: "v1",
        store: new MemoryVectorStore(),
        embedding: {
          info: identity,
          async embed(texts, context) {
            calls++;
            return fixture.embed(texts, context);
          },
        },
        authorize: () => ({ namespace: "alice", sources: { paper: "r1" } }),
      },
    ],
    {
      usage: {
        hostId: "host",
        onUsage() {
          throw new Error("backend unavailable");
        },
        onTelemetryError() {
          errors++;
        },
      },
    },
  );
  assert.equal((await retrieval.index(document, ctx)).status, "indexed");
  assert.equal((await retrieval.index(document, ctx)).status, "unchanged");
  assert.equal(calls, 1);
  assert.equal(errors, 1);
});

test("batch byte limits and account bindings fail before unbounded embedding work", async () => {
  const fixture = new DeterministicEmbeddingAdapter(16);
  let calls = 0;
  const corpus = {
    id: "library",
    version: "v1",
    store: new MemoryVectorStore(),
    embedding: {
      info: identity,
      async embed(texts: readonly string[], context: ExecutionContext) {
        calls++;
        return fixture.embed(texts, context);
      },
    },
    authorize: () => ({ namespace: "alice", sources: { paper: "r1" } }),
  };
  const retrieval = new RetrievalService([corpus], {
    embeddingBatch: { maxBytes: 1 },
  });
  await assert.rejects(retrieval.index(document, ctx), {
    code: "INVALID_RETRIEVAL",
  });
  assert.equal(calls, 0);
  assert.throws(
    () =>
      new RetrievalService([corpus], { usage: { hostId: "", onUsage() {} } }),
    { code: "INVALID_USAGE_CONFIG" },
  );
  assert.throws(
    () =>
      new RetrievalService(
        [
          corpus,
          {
            ...corpus,
            id: "other",
            embedding: {
              ...corpus.embedding,
              info: { ...identity, accountId: "other-account" },
            },
          },
        ],
        { usage: { hostId: "host", onUsage() {} } },
      ),
    { code: "INVALID_USAGE_CONFIG" },
  );
});
