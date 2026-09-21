import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { AgenticDriver } from "../src/driver.js";
import { DriverError } from "../src/errors.js";
import { MemoryOperationStore } from "../src/operations.js";
import { mockProvider } from "../src/providers/index.js";
import {
  DeterministicEmbeddingAdapter,
  RetrievalService,
  SqliteVectorStore,
  type EmbeddingAdapter,
  type RetrievalAuthorization,
} from "../src/retrieval.js";
import type { IngestRequest, IngestionOptions } from "../src/ingestion.js";
import type { ExecutionContext } from "../src/types.js";

const source = {
  id: "paper",
  revision: "r1",
  title: "Selected evidence",
  uri: "app://library/paper",
};
const options = { subject: "alice" };
const search = {
  corpus: "library",
  sourceIds: [source.id],
  query: "evidence",
  limit: 16,
};
const context = (): ExecutionContext => ({
  runId: "persistent-ingestion",
  subject: options.subject,
  signal: new AbortController().signal,
  reportProgress() {},
});
const markdown = (text: string, revision = "r1"): IngestRequest => ({
  corpus: "library",
  document: {
    type: "text",
    mediaType: "text/markdown",
    source: { ...source, revision },
    text,
  },
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((ready) => {
    resolve = ready;
  });
  return { promise, resolve };
}

async function persistentHost(
  t: TestContext,
  config: {
    ingestion?: IngestionOptions;
    embedding?: EmbeddingAdapter;
    batchSize?: number;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "ad-ingestion-persistence-"));
  const path = join(directory, "vectors.db");
  let store = await SqliteVectorStore.open(path);
  t.after(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const grants = new Map<string, RetrievalAuthorization>([
    ["alice", { namespace: "alice", sources: { paper: "r1", other: "r1" } }],
    ["bob", { namespace: "bob", sources: { paper: "r1" } }],
  ]);
  const calls = { embedding: 0, generation: 0 };
  const adapter = config.embedding ?? new DeterministicEmbeddingAdapter(64);
  const operations = new MemoryOperationStore();
  let reply = "Evidence";
  function connect() {
    const retrieval = new RetrievalService(
      [
        {
          id: "library",
          version: "v1",
          store,
          embedding: {
            info: adapter.info,
            async embed(texts, ctx) {
              calls.embedding++;
              return adapter.embed(texts, ctx);
            },
          },
          authorize: (_, ctx) => grants.get(ctx.subject) ?? null,
        },
      ],
      { embeddingBatch: { maxTexts: config.batchSize ?? 32 } },
    );
    const driver = new AgenticDriver({
      retrieval,
      ingestion: config.ingestion,
      operations,
      providers: [
        mockProvider(() => {
          calls.generation++;
          return { text: reply };
        }),
      ],
    });
    return { retrieval, driver };
  }
  let active = connect();
  return {
    grants,
    calls,
    get driver() {
      return active.driver;
    },
    get retrieval() {
      return active.retrieval;
    },
    reply(text: string) {
      reply = text;
    },
    async reopen() {
      await store.close();
      store = await SqliteVectorStore.open(path);
      active = connect();
    },
  };
}

const documents: {
  format: "markdown" | "email" | "pdf";
  request: IngestRequest;
  locations: Record<string, string | number>[];
  ingestion?: IngestionOptions;
}[] = [
  {
    format: "markdown",
    request: {
      corpus: "library",
      document: {
        type: "text",
        mediaType: "text/markdown",
        source: { ...source, location: { startLine: 20 } },
        text: "# Evidence\nEvidence one.\n\n# Discussion\nEvidence two.",
      },
    },
    locations: [
      { section: "Evidence", startLine: 20, endLine: 22 },
      { section: "Discussion", startLine: 23, endLine: 24 },
    ],
  },
  {
    format: "email",
    request: {
      corpus: "library",
      document: {
        type: "email",
        source,
        threadId: "thread-one",
        messages: [
          { id: "message-one", text: "Evidence one.\nFirst message." },
          { id: "message-empty", text: "  \n" },
          { id: "message-two", text: "Evidence two." },
        ],
      },
    },
    locations: [
      {
        threadId: "thread-one",
        messageId: "message-one",
        startLine: 1,
        endLine: 2,
      },
      {
        threadId: "thread-one",
        messageId: "message-two",
        startLine: 1,
        endLine: 1,
      },
    ],
  },
  {
    format: "pdf",
    request: {
      corpus: "library",
      document: {
        type: "pdf",
        mediaType: "application/pdf",
        source: { ...source, location: { page: 5 } },
        // An explicit extractor fixture; native PDF parsing has separate integration tests.
        data: Buffer.from("%PDF-fixture persistent pages").toString("base64"),
      },
    },
    ingestion: {
      pdf: {
        async extract() {
          return {
            extractor: { id: "persistence-fixture", version: "1" },
            pages: [
              { page: 1, text: "Evidence one.\nFirst page." },
              { page: 2, text: "Evidence two." },
            ],
          };
        },
      },
    },
    locations: [
      { page: 5, pageEnd: 5, startLine: 1, endLine: 2 },
      { page: 6, pageEnd: 6, startLine: 1, endLine: 1 },
    ],
  },
];

for (const document of documents)
  test(`SQLite ingestion: ${document.format} provenance and citation targets survive reopening`, async (t) => {
    const host = await persistentHost(t, { ingestion: document.ingestion });
    const receipt = await host.driver.ingestContext(document.request, options);
    const original = await host.driver.searchContext(search, options);
    assert.equal(receipt.ingestion.format, document.format);
    assert.equal(original.hits.length, document.locations.length);
    for (const expected of document.locations) {
      const hit = original.hits.find((hit) =>
        Object.entries(expected).every(
          ([key, value]) =>
            hit.source.location?.[key as keyof typeof hit.source.location] ===
            value,
        ),
      );
      assert.ok(hit, `Missing persisted location ${JSON.stringify(expected)}`);
      assert.equal(hit.source.location!.documentId, source.id);
      assert.equal(hit.source.revision, source.revision);
      assert.equal(hit.source.uri, source.uri);
      assert.equal(hit.documentSha256, receipt.documentSha256);
      assert.deepEqual(hit.ingestion, receipt.ingestion);
    }

    await host.reopen();
    assert.deepEqual(
      await host.driver.searchContext(search, options),
      original,
    );
    const beforeRepeat = host.calls.embedding;
    assert.deepEqual(
      await host.driver.ingestContext(document.request, options),
      {
        ...receipt,
        status: "unchanged",
      },
    );
    assert.equal(
      host.calls.embedding,
      beforeRepeat,
      "unchanged revisions must not embed again",
    );

    const cited = original.hits[0]!;
    host.reply(`Evidence [source:${cited.chunkId}]`);
    const result = await host.driver.run(
      {
        provider: "mock",
        model: "demo",
        input: "evidence",
        retrieval: search,
        outputArtifact: { name: "answer.md", mediaType: "text/markdown" },
      },
      options,
    );
    assert.deepEqual(result.retrieval, original);
    assert.equal(result.artifacts![0]!.status, "draft");
    assert.equal(
      result.artifacts![0]!.content,
      `Evidence [source:${cited.chunkId}]`,
    );
    assert.deepEqual(
      result.artifacts![0]!.sourceIds,
      original.hits.map((hit) => hit.chunkId),
    );
    for (const hit of original.hits) {
      const citation = result.sources!.find((item) => item.id === hit.chunkId)!;
      assert.ok(citation);
      assert.equal(citation.origin, "retrieval");
      assert.equal(citation.revision, source.revision);
      assert.equal(citation.uri, source.uri);
      assert.deepEqual(citation.location, hit.source.location);
      assert.equal(
        citation.sha256,
        createHash("sha256").update(hit.text).digest("hex"),
      );
    }
  });

test("SQLite ingestion: replacement, source selection, revocation and deletion survive reopening", async (t) => {
  const host = await persistentHost(t);
  const first = markdown("# Evidence\nOriginal Alice evidence.");
  await host.driver.ingestContext(first, options);
  await host.driver.ingestContext(markdown("Bob's private evidence."), {
    subject: "bob",
  });
  await host.driver.ingestContext(
    {
      corpus: "library",
      document: {
        type: "text",
        mediaType: "text/plain",
        source: { id: "other", revision: "r1" },
        text: "Unselected evidence.",
      },
    },
    options,
  );
  const original = await host.driver.searchContext(search, options);
  const runRequest = {
    provider: "mock",
    model: "demo",
    input: "evidence",
    retrieval: search,
    idempotencyKey: "persistent-evidence-replay",
  };
  const answer = await host.driver.run(runRequest, options);
  await host.reopen();
  assert.deepEqual(await host.driver.run(runRequest, options), answer);
  assert.equal(host.calls.generation, 1);
  assert.deepEqual(await host.driver.searchContext(search, options), original);
  assert.ok(
    original.hits.every(
      (hit) => hit.source.id === "paper" && hit.text.includes("Alice"),
    ),
  );

  delete host.grants.get("alice")!.sources.paper;
  const beforeDenied = { ...host.calls };
  await assert.rejects(host.driver.searchContext(search, options), {
    code: "CONTEXT_NOT_FOUND",
  });
  await assert.rejects(host.driver.run(runRequest, options), {
    code: "CONTEXT_NOT_FOUND",
  });
  await assert.rejects(host.driver.ingestContext(first, options), {
    code: "CONTEXT_NOT_FOUND",
  });
  assert.deepEqual(
    host.calls,
    beforeDenied,
    "denied sources must not reach an embedding or generation adapter",
  );
  assert.deepEqual(
    (
      await host.driver.searchContext(
        { corpus: "library", query: "evidence" },
        options,
      )
    ).hits.map((hit) => hit.source.id),
    ["other"],
  );

  host.grants.get("alice")!.sources.paper = "r2";
  assert.deepEqual((await host.driver.searchContext(search, options)).hits, []);
  await assert.rejects(host.driver.ingestContext(first, options), {
    code: "CONTEXT_NOT_FOUND",
  });
  const receipt = await host.driver.ingestContext(
    markdown("# Evidence\nUpdated Alice evidence.", "r2"),
    options,
  );
  await host.reopen();
  const updated = await host.driver.searchContext(search, options);
  assert.equal(updated.hits.length, 1);
  assert.equal(updated.hits[0]!.source.revision, "r2");
  assert.equal(updated.hits[0]!.documentSha256, receipt.documentSha256);
  assert.notEqual(updated.hits[0]!.chunkId, original.hits[0]!.chunkId);
  await assert.rejects(host.retrieval.revalidate(search, original, context()), {
    code: "CONTEXT_NOT_FOUND",
  });
  await assert.rejects(host.driver.run(runRequest, options), {
    code: "CONTEXT_NOT_FOUND",
  });
  assert.equal(host.calls.generation, 1);
  await assert.rejects(
    host.driver.ingestContext(markdown("Changed bytes", "r2"), options),
    { code: "SOURCE_CONFLICT" },
  );

  assert.equal(
    (
      await host.driver.deleteContext(
        { corpus: "library", sourceId: "paper", revision: "r2" },
        options,
      )
    ).deleted,
    true,
  );
  await host.reopen();
  assert.deepEqual((await host.driver.searchContext(search, options)).hits, []);
  await assert.rejects(host.retrieval.revalidate(search, updated, context()), {
    code: "CONTEXT_NOT_FOUND",
  });
  const bob = await host.driver.searchContext(search, { subject: "bob" });
  assert.equal(bob.hits.length, 1);
  assert.match(bob.hits[0]!.text, /Bob/);
});

test("SQLite ingestion: revocation during a search cannot expose persisted passages or start generation", async (t) => {
  const fixture = new DeterministicEmbeddingAdapter(64);
  let revoke: (() => void) | undefined;
  const host = await persistentHost(t, {
    embedding: {
      info: fixture.info,
      async embed(texts, ctx) {
        const result = await fixture.embed(texts, ctx);
        revoke?.();
        return result;
      },
    },
  });
  await host.driver.ingestContext(
    markdown("# Evidence\nPersisted private evidence."),
    options,
  );
  await host.reopen();
  const original = await host.driver.searchContext(search, options);
  revoke = () => {
    delete host.grants.get("alice")!.sources.paper;
  };
  await assert.rejects(host.driver.searchContext(search, options), {
    code: "CONTEXT_NOT_FOUND",
  });
  host.grants.get("alice")!.sources.paper = "r1";
  await assert.rejects(
    host.driver.run(
      { provider: "mock", model: "demo", input: "evidence", retrieval: search },
      options,
    ),
    { code: "CONTEXT_NOT_FOUND" },
  );
  assert.equal(host.calls.generation, 0);
  revoke = undefined;
  host.grants.get("alice")!.sources.paper = "r1";
  await host.reopen();
  assert.deepEqual(await host.driver.searchContext(search, options), original);
});

for (const failure of ["cancelled", "embedding-error", "revoked"] as const)
  test(
    `SQLite ingestion: ${failure} replacement retains the prior revision after reopening`,
    { timeout: 5000 },
    async (t) => {
      const fixture = new DeterministicEmbeddingAdapter(64);
      const entered = gate();
      const finish = gate();
      const settled = gate();
      t.after(() => finish.resolve());
      let replacing = false;
      let replacementCalls = 0;
      const host = await persistentHost(t, {
        batchSize: 1,
        embedding: {
          info: fixture.info,
          async embed(texts, ctx) {
            if (replacing && ++replacementCalls === 2) {
              entered.resolve();
              await finish.promise;
              try {
                if (failure === "embedding-error")
                  throw new DriverError(
                    "EMBEDDING_HTTP_ERROR",
                    "Fixture batch failure",
                  );
                // Simulates an adapter that returns a valid late result after cancellation.
                return await fixture.embed(texts, {
                  ...ctx,
                  signal: new AbortController().signal,
                });
              } finally {
                settled.resolve();
              }
            }
            return fixture.embed(texts, ctx);
          },
        },
      });
      await host.driver.ingestContext(
        markdown("# Evidence\nComplete original evidence."),
        options,
      );
      const original = await host.driver.searchContext(search, options);
      host.grants.get("alice")!.sources.paper = "r2";
      replacing = true;
      const controller = new AbortController();
      const replacement = host.driver.ingestContext(
        markdown(
          "# First\nNew evidence one.\n# Second\nNew evidence two.\n# Third\nNew evidence three.",
          "r2",
        ),
        { ...options, signal: controller.signal },
      );
      const rejected = assert.rejects(replacement, {
        code:
          failure === "cancelled"
            ? "CANCELLED"
            : failure === "revoked"
              ? "CONTEXT_NOT_FOUND"
              : "EMBEDDING_HTTP_ERROR",
      });
      await Promise.race([
        entered.promise,
        rejected.then(() =>
          assert.fail("Replacement must reach its second embedding batch"),
        ),
      ]);
      if (failure === "cancelled") {
        controller.abort();
        await rejected;
      } else if (failure === "revoked") {
        delete host.grants.get("alice")!.sources.paper;
      }
      finish.resolve();
      await settled.promise;
      await rejected;
      await setImmediate();
      assert.equal(
        replacementCalls,
        2,
        "the third batch must not run after interruption",
      );
      replacing = false;
      host.grants.get("alice")!.sources.paper = "r1";
      await host.reopen();
      assert.deepEqual(
        await host.driver.searchContext(search, options),
        original,
      );
      assert.equal(
        (
          await host.driver.ingestContext(
            markdown("# Evidence\nComplete original evidence."),
            options,
          )
        ).status,
        "unchanged",
      );
      host.grants.get("alice")!.sources.paper = "r2";
      assert.deepEqual(
        (await host.driver.searchContext(search, options)).hits,
        [],
      );
    },
  );
